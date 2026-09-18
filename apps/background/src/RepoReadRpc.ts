import type { GitService } from '@edge-git/git-service';
import { PackLimitError } from '@edge-git/git-service';
import type { IsoGitFs } from '@edge-git/git-service';
import type { ReadModelService } from './ReadModelService';
import type { ReleaseAssetStore } from './ReleaseAssetStore';

type IsoGitFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

/**
 * Read-model RPC fan-out for `RepoWorker`.
 * Extracted from the 491 LOC `RepoWorker` god-file so the Durable Object keeps
 * only lifecycle + pack routing while all `getBranches/Tree/Blob/Commits`
 * passthroughs live here behind a single `prepare()` gate.
 */
class RepoReadRpc {
  constructor(
    private readonly git: GitService,
    private readonly readModel: ReadModelService,
    private readonly prepare: () => Promise<void>,
    private readonly getMaxMergeDiffFiles: () => number,
    private readonly getMaxFileBytes: () => number,
    private readonly isoGitFs?: IsoGitFsClient,
    private readonly releaseAssets?: ReleaseAssetStore,
    private readonly getLimits?: () => { maxObjects: number; maxPackBytes: number },
  ) {}

  public async listRefs(): Promise<{ refs: Array<{ ref: string; oid: string }>; symbolicHead: string | null }> {
    await this.prepare();
    return this.git.listRefs();
  }

  public async getLatestCommit(branch = 'HEAD'): Promise<unknown> {
    await this.prepare();
    return this.readModel.getLatestCommit(branch);
  }

  public async getCommits(args: { ref?: string; depth?: number; filepath?: string }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getCommits(args);
  }

  public async getBranches(): Promise<{ branches: string[]; currentBranch: string | null }> {
    await this.prepare();
    return this.readModel.getBranches();
  }

  public async createBranch(args: { name: string; fromRef?: string }): Promise<unknown> {
    await this.prepare();
    const startOid = await this.git.resolveRef(args.fromRef || 'HEAD');
    if (!startOid) return { ok: false, error: 'unknown start point', status: 404 };
    const result = await this.git.createBranch(args.name, startOid);
    if ((result as { ok?: boolean }).ok) this.git.clearCache();
    return result;
  }

  public async deleteBranchRef(branch: string): Promise<unknown> {
    await this.prepare();
    const result = await this.git.deleteBranchRef(branch);
    if ((result as { ok?: boolean }).ok) this.git.clearCache();
    return result;
  }

  public async commitFile(args: {
    branch: string;
    path: string;
    content: Uint8Array | null;
    message?: string;
    expectedOid?: string | null;
    authorName: string;
    authorEmail: string;
  }): Promise<unknown> {
    await this.prepare();
    const result = await this.git.commitFile({
      branch: args.branch,
      path: args.path,
      content: args.content,
      message: args.message,
      expectedOid: args.expectedOid,
      author: { name: args.authorName, email: args.authorEmail },
      maxFileBytes: this.getMaxFileBytes(),
    });
    if ((result as { ok?: boolean }).ok) this.git.clearCache();
    return result;
  }

  public async setDefaultBranch(branch: string): Promise<unknown> {
    await this.prepare();
    const result = await this.git.setDefaultBranch(branch);
    if ((result as { ok?: boolean }).ok) this.git.clearCache();
    return result;
  }

  public async getTags(): Promise<Array<{ name: string; ref: string; oid: string; peeledOid: string | null; type: 'lightweight' | 'annotated' }>> {
    await this.prepare();
    return this.readModel.getTags();
  }

  public async getTree(args: { ref?: string; path?: string; withLastCommit?: boolean }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getTree(args);
  }

  public async getBlob(args: { ref?: string; filepath: string }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getBlob(args);
  }

  public async getOverview(args: { ref?: string; path?: string; depth?: number; includeTags?: boolean; includeReadme?: boolean }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getOverview(args);
  }

  public async listAllFiles(args: { ref?: string; maxFiles?: number }): Promise<Array<{ path: string; oid: string }>> {
    await this.prepare();
    return this.readModel.listAllFiles(args);
  }

  public async getCommit(commitOid: string): Promise<unknown> {
    await this.prepare();
    return this.readModel.getCommit(commitOid);
  }

  public async getCommitDiff(commitOid: string): Promise<unknown> {
    await this.prepare();
    return this.readModel.getCommitDiff(commitOid, this.getMaxMergeDiffFiles());
  }

  public async getCompare(args: { baseRef: string; headRef: string }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getCompare(args.baseRef, args.headRef, this.getMaxMergeDiffFiles());
  }

  public async getMergePreview(args: { baseRef: string; headRef: string }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getMergePreview(args.baseRef, args.headRef);
  }

  public async getMergePreviewByOids(args: { baseOid: string; headOid: string }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getMergePreviewByOids(args.baseOid, args.headOid);
  }

  public async resolveRef(ref: string): Promise<string | null> {
    await this.prepare();
    return this.git.resolveRef(ref);
  }

  public async hasObject(oid: string): Promise<boolean> {
    await this.prepare();
    return this.git.hasObject(oid);
  }

  public async isAncestor(ancestor: string, oid: string): Promise<boolean> {
    await this.prepare();
    if (!/^[0-9a-f]{40}$/.test(ancestor) || !/^[0-9a-f]{40}$/.test(oid)) return false;
    try {
      return await this.git.isAncestor(ancestor, oid);
    } catch {
      return false;
    }
  }

  public async updateRefs(updates: Array<{ ref: string; oldOid: string; newOid: string }>): Promise<unknown> {
    await this.prepare();
    const pending = (updates ?? []).filter(
      (u) => typeof u.ref === 'string' && (u.ref.startsWith('refs/heads/') || u.ref.startsWith('refs/tags/')) && /^[0-9a-f]{40}$/.test(u.oldOid) && /^[0-9a-f]{40}$/.test(u.newOid),
    );
    if (pending.length === 0) return { updated: [] };
    const results = await this.git.applyRefUpdates(
      pending.map((u) => ({ oldOid: u.oldOid, newOid: u.newOid, ref: u.ref })),
      false,
    );
    this.git.clearCache();
    const updated: string[] = [];
    for (const [i, result] of results.entries()) {
      if (result.ok) updated.push(pending[i].ref);
    }
    return { updated };
  }

  public async exportPack(wants: string[]): Promise<{ oids: string[]; pack: Uint8Array | null }> {
    await this.prepare();
    if (wants.length === 0) return { oids: [], pack: null };
    const limits = this.getLimits?.() ?? { maxObjects: 10_000, maxPackBytes: 52_428_800 };
    const { oids } = await this.git.collectObjectsForPack(wants, [], { maxObjects: limits.maxObjects });
    if (oids.length === 0) return { oids, pack: null };
    const pack = (await this.git.packObjects(oids)) as Uint8Array | undefined;
    if (!pack || pack.byteLength === 0) return { oids, pack: null };
    if (pack.byteLength > limits.maxPackBytes) {
      throw new PackLimitError(`pack too large: ${pack.byteLength} > ${limits.maxPackBytes} bytes`);
    }
    return { oids, pack };
  }

  public async importPack(pack: Uint8Array, refs?: Array<{ ref: string; oid: string }>): Promise<{ importedRefs: string[] }> {
    await this.prepare();
    if (!pack || pack.byteLength === 0) return { importedRefs: [] };
    const limits = this.getLimits?.() ?? { maxObjects: 10_000, maxPackBytes: 52_428_800 };
    if (pack.byteLength > limits.maxPackBytes) {
      throw new PackLimitError(`pack too large: ${pack.byteLength} > ${limits.maxPackBytes} bytes`);
    }
    if (!this.isoGitFs) return { importedRefs: [] };
    const suffix = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const packFilePath = `/repo/objects/pack/fork-${suffix}.pack`;
    let wrotePack = false;
    try {
      await this.isoGitFs.promises.writeFile(packFilePath, pack);
      wrotePack = true;
      await this.git.indexPack(packFilePath.replace('/repo/', ''));
    } catch (error) {
      if (wrotePack) {
        await this.isoGitFs.promises.unlink(packFilePath).catch(() => undefined);
      }
      throw error;
    }
    this.git.clearCache();
    const importedRefs: string[] = [];
    const pending = (refs ?? []).filter((r) => typeof r.ref === 'string' && /^[0-9a-f]{40}$/.test(r.oid));
    if (pending.length > 0) {
      const results = await this.git.applyRefUpdates(
        pending.map((r) => ({ oldOid: '0'.repeat(40), newOid: r.oid, ref: r.ref })),
        false,
      );
      for (const [i, result] of results.entries()) {
        if (result.ok) importedRefs.push(pending[i].ref);
      }
      this.git.clearCache();
    }
    return { importedRefs };
  }

  public async getPullDiff(args: { baseOid: string | null; headOid: string }): Promise<unknown> {
    await this.prepare();
    return this.readModel.getPullDiff(args.baseOid, args.headOid, this.getMaxMergeDiffFiles());
  }

  public async mergePull(args: {
    baseBranch: string;
    headBranch?: string;
    headOid: string;
    authorName: string;
    authorEmail: string;
    message?: string;
    deleteHead?: boolean;
    strategy?: 'merge' | 'squash' | 'rebase';
  }): Promise<unknown> {
    await this.prepare();
    const strategy = args.strategy ?? 'merge';
    const author = { name: args.authorName, email: args.authorEmail };
    const outcome =
      strategy === 'squash'
        ? await this.git.squashMerge({ baseBranch: args.baseBranch, headOid: args.headOid, author, message: args.message })
        : strategy === 'rebase'
          ? await this.git.rebaseMerge({ baseBranch: args.baseBranch, headOid: args.headOid, author })
          : await this.git.mergeBranches({ baseBranch: args.baseBranch, headOid: args.headOid, author, message: args.message });
    if ((outcome as { type?: string }).type !== 'conflict') {
      this.git.clearCache();
    }
    let deletedHead = false;
    if (args.deleteHead && (outcome as { type?: string }).type !== 'conflict' && args.headBranch && args.headBranch !== args.baseBranch) {
      try {
        await this.git.deleteBranch(args.headBranch);
        deletedHead = true;
        this.git.clearCache();
      } catch {
        deletedHead = false;
      }
    }
    return { ...outcome, deletedHead };
  }

  public async deleteBranch(branch: string): Promise<{ deleted: boolean }> {
    await this.prepare();
    try {
      await this.git.deleteBranch(branch);
      this.git.clearCache();
      return { deleted: true };
    } catch {
      return { deleted: false };
    }
  }

  public async getBlame(args: { ref?: string; filepath: string }): Promise<unknown> {
    await this.prepare();
    if (!args.filepath || args.filepath.length > 500) return null;
    return this.readModel.getBlame(args.ref ?? 'HEAD', args.filepath);
  }

  public async storeReleaseAsset(args: { releaseId: string; assetId: string; bytes: Uint8Array }): Promise<unknown> {
    await this.prepare();
    if (!this.releaseAssets) throw new Error('Release assets are not configured');
    return this.releaseAssets.store(args);
  }

  public async getReleaseAsset(args: { releaseId: string; assetId: string }): Promise<Uint8Array | null> {
    await this.prepare();
    if (!this.releaseAssets) return null;
    return this.releaseAssets.load(args);
  }

  public async deleteReleaseAsset(args: { releaseId: string; assetId: string }): Promise<{ deleted: boolean }> {
    await this.prepare();
    if (!this.releaseAssets) return { deleted: false };
    return this.releaseAssets.remove(args);
  }

  public async deleteReleaseAssets(args: { releaseId: string }): Promise<{ deleted: number }> {
    await this.prepare();
    if (!this.releaseAssets) return { deleted: 0 };
    return this.releaseAssets.removeAll(args);
  }
}

export { RepoReadRpc };
