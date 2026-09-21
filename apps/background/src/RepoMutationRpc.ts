import { PackLimitError } from '@edge-git/git-service';
import type { RepoRpcDeps } from './RepoRpcDeps';

// Mutation slice of the `RepoWorker` RPC surface: branch/file/ref writes plus
// pack import and merge orchestration. Composed by the `RepoReadRpc` facade
// so the Durable Object keeps a single `reads` handle.
class RepoMutationRpc {
  constructor(private readonly deps: RepoRpcDeps) {}

  public async createBranch(args: { name: string; fromRef?: string }): Promise<unknown> {
    await this.deps.prepare();
    const startOid = await this.deps.git.resolveRef(args.fromRef || 'HEAD');
    if (!startOid) return { ok: false, error: 'unknown start point', status: 404 };
    const result = await this.deps.git.createBranch(args.name, startOid);
    if ((result as { ok?: boolean }).ok) this.deps.git.clearCache();
    return result;
  }

  public async deleteBranchRef(branch: string): Promise<unknown> {
    await this.deps.prepare();
    const result = await this.deps.git.deleteBranchRef(branch);
    if ((result as { ok?: boolean }).ok) this.deps.git.clearCache();
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
    await this.deps.prepare();
    const result = await this.deps.git.commitFile({
      branch: args.branch,
      path: args.path,
      content: args.content,
      message: args.message,
      expectedOid: args.expectedOid,
      author: { name: args.authorName, email: args.authorEmail },
      maxFileBytes: this.deps.config.getMaxFileBytes(),
    });
    if ((result as { ok?: boolean }).ok) this.deps.git.clearCache();
    return result;
  }

  public async setDefaultBranch(branch: string): Promise<unknown> {
    await this.deps.prepare();
    const result = await this.deps.git.setDefaultBranch(branch);
    if ((result as { ok?: boolean }).ok) this.deps.git.clearCache();
    return result;
  }

  public async updateRefs(updates: Array<{ ref: string; oldOid: string; newOid: string }>): Promise<unknown> {
    await this.deps.prepare();
    const ZERO_OID = '0'.repeat(40);
    const pending = (updates ?? []).filter(
      (u) =>
        typeof u.ref === 'string' &&
        (u.ref.startsWith('refs/heads/') || u.ref.startsWith('refs/tags/')) &&
        /^[0-9a-f]{40}$/.test(u.oldOid) &&
        /^[0-9a-f]{40}$/.test(u.newOid),
    );
    if (pending.length === 0) return { updated: [] };
    // Bound direct-RPC fan-out: production import/mirror paths bound via
    // transferLimits().maxRefs, but direct stub calls bypassed it.
    const maxRefs = this.deps.getLimits?.().maxRefs ?? 1000;
    if (pending.length > maxRefs) {
      throw new PackLimitError(`too many refs: ${pending.length} > ${maxRefs}`);
    }
    // Fail closed on deletions and tag overwrites: this RPC is used by
    // mirror/fork-sync which only create (old zero) + fast-forward heads.
    // Deletions (new zero) and tag overwrites (existing tag, new oid) must
    // go through push protection in PushHandler, not direct RPC.
    const safe = pending.filter((u) => {
      if (u.newOid === ZERO_OID) return false;
      if (u.ref.startsWith('refs/tags/') && u.oldOid !== ZERO_OID) return false;
      return true;
    });
    if (safe.length === 0) return { updated: [] };
    const results = await this.deps.git.applyRefUpdates(
      safe.map((u) => ({ oldOid: u.oldOid, newOid: u.newOid, ref: u.ref })),
      false,
    );
    this.deps.git.clearCache();
    const updated: string[] = [];
    for (const [i, result] of results.entries()) {
      if (result.ok) updated.push(safe[i].ref);
    }
    return { updated };
  }

  public async importPack(pack: Uint8Array, refs?: Array<{ ref: string; oid: string }>): Promise<{ importedRefs: string[] }> {
    await this.deps.prepare();
    if (!pack || pack.byteLength === 0) return { importedRefs: [] };
    const limits = this.deps.getLimits?.() ?? { maxObjects: 10_000, maxPackBytes: 52_428_800 };
    if (pack.byteLength > limits.maxPackBytes) {
      throw new PackLimitError(`pack too large: ${pack.byteLength} > ${limits.maxPackBytes} bytes`);
    }
    const maxRefs = limits.maxRefs ?? 1000;
    const pending = (refs ?? []).filter((r) => typeof r.ref === 'string' && /^[0-9a-f]{40}$/.test(r.oid));
    if (pending.length > maxRefs) {
      throw new PackLimitError(`too many refs: ${pending.length} > ${maxRefs}`);
    }
    if (!this.deps.isoGitFs) return { importedRefs: [] };
    const suffix = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const packFilePath = `/repo/objects/pack/fork-${suffix}.pack`;
    let wrotePack = false;
    try {
      await this.deps.isoGitFs.promises.writeFile(packFilePath, pack);
      wrotePack = true;
      await this.deps.git.indexPack(packFilePath.replace('/repo/', ''));
    } catch (error) {
      if (wrotePack) {
        await this.deps.isoGitFs.promises.unlink(packFilePath).catch(() => undefined);
      }
      throw error;
    }
    this.deps.git.clearCache();
    const importedRefs: string[] = [];
    if (pending.length > 0) {
      const results = await this.deps.git.applyRefUpdates(
        pending.map((r) => ({ oldOid: '0'.repeat(40), newOid: r.oid, ref: r.ref })),
        false,
      );
      for (const [i, result] of results.entries()) {
        if (result.ok) importedRefs.push(pending[i].ref);
      }
      this.deps.git.clearCache();
    }
    return { importedRefs };
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
    await this.deps.prepare();
    const strategy = args.strategy ?? 'merge';
    const author = { name: args.authorName, email: args.authorEmail };
    const outcome =
      strategy === 'squash'
        ? await this.deps.git.squashMerge({ baseBranch: args.baseBranch, headOid: args.headOid, author, message: args.message })
        : strategy === 'rebase'
          ? await this.deps.git.rebaseMerge({ baseBranch: args.baseBranch, headOid: args.headOid, author })
          : await this.deps.git.mergeBranches({ baseBranch: args.baseBranch, headOid: args.headOid, author, message: args.message });
    if ((outcome as { type?: string }).type !== 'conflict') {
      this.deps.git.clearCache();
    }
    let deletedHead = false;
    if (args.deleteHead && (outcome as { type?: string }).type !== 'conflict' && args.headBranch && args.headBranch !== args.baseBranch) {
      try {
        await this.deps.git.deleteBranch(args.headBranch);
        deletedHead = true;
        this.deps.git.clearCache();
      } catch {
        deletedHead = false;
      }
    }
    return { ...outcome, deletedHead };
  }

  public async deleteBranch(branch: string): Promise<{ deleted: boolean }> {
    await this.deps.prepare();
    try {
      await this.deps.git.deleteBranch(branch);
      this.deps.git.clearCache();
      return { deleted: true };
    } catch {
      return { deleted: false };
    }
  }

  public async storeReleaseAsset(args: { releaseId: string; assetId: string; bytes: Uint8Array }): Promise<unknown> {
    await this.deps.prepare();
    if (!this.deps.releaseAssets) throw new Error('Release assets are not configured');
    return this.deps.releaseAssets.store(args);
  }

  public async deleteReleaseAsset(args: { releaseId: string; assetId: string }): Promise<{ deleted: boolean }> {
    await this.deps.prepare();
    if (!this.deps.releaseAssets) return { deleted: false };
    return this.deps.releaseAssets.remove(args);
  }

  public async deleteReleaseAssets(args: { releaseId: string }): Promise<{ deleted: number }> {
    await this.deps.prepare();
    if (!this.deps.releaseAssets) return { deleted: 0 };
    return this.deps.releaseAssets.removeAll(args);
  }
}

export { RepoMutationRpc };
