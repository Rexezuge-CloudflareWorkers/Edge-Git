import { PackLimitError } from '@edge-git/git-service';
import type { RepoRpcDeps } from './RepoRpcDeps';

// Query slice of the `RepoWorker` RPC surface: read-only passthroughs behind
// the shared `prepare()` gate. Composed by the `RepoReadRpc` facade so the
// Durable Object keeps a single `reads` handle.
class RepoQueryRpc {
  constructor(private readonly deps: RepoRpcDeps) {}

  private get config() {
    return this.deps.config;
  }

  private getMaxMergeDiffFiles(): number {
    return this.config.getMaxMergeDiffFiles();
  }

  public async listRefs(): Promise<{ refs: Array<{ ref: string; oid: string }>; symbolicHead: string | null }> {
    await this.deps.prepare();
    return this.deps.git.listRefs();
  }

  public async getLatestCommit(branch = 'HEAD'): Promise<unknown> {
    await this.deps.prepare();
    return this.deps.readModel.getLatestCommit(branch);
  }

  public async getCommits(args: { ref?: string; depth?: number; filepath?: string }): Promise<unknown> {
    await this.deps.prepare();
    return this.deps.readModel.getCommits(args);
  }

  public async getBranches(): Promise<{ branches: string[]; currentBranch: string | null }> {
    await this.deps.prepare();
    return this.deps.readModel.getBranches();
  }

  public async getTags(): Promise<
    Array<{ name: string; ref: string; oid: string; peeledOid: string | null; type: 'lightweight' | 'annotated' }>
  > {
    await this.deps.prepare();
    return this.deps.readModel.getTags();
  }

  public async getTree(args: { ref?: string; path?: string; withLastCommit?: boolean }): Promise<unknown> {
    await this.deps.prepare();
    return this.deps.readModel.getTree(args);
  }

  public async getBlob(args: { ref?: string; filepath: string }): Promise<unknown> {
    await this.deps.prepare();
    return this.deps.readModel.getBlob(args);
  }

  public async getOverview(args: {
    ref?: string;
    path?: string;
    depth?: number;
    includeTags?: boolean;
    includeReadme?: boolean;
  }): Promise<unknown> {
    await this.deps.prepare();
    return this.deps.readModel.getOverview(args);
  }

  public async listAllFiles(args: { ref?: string; maxFiles?: number }): Promise<Array<{ path: string; oid: string }>> {
    await this.deps.prepare();
    return this.deps.readModel.listAllFiles(args);
  }

  public async getCommit(commitOid: string): Promise<unknown> {
    await this.deps.prepare();
    return this.deps.readModel.getCommit(commitOid);
  }

  public async getCommitDiff(commitOid: string): Promise<unknown> {
    await this.deps.prepare();
    return this.deps.readModel.getCommitDiff(commitOid, this.getMaxMergeDiffFiles());
  }

  public async getCompare(args: { baseRef: string; headRef: string }): Promise<unknown> {
    await this.deps.prepare();
    return this.deps.readModel.getCompare(args.baseRef, args.headRef, this.getMaxMergeDiffFiles());
  }

  public async getMergePreview(args: { baseRef: string; headRef: string }): Promise<unknown> {
    await this.deps.prepare();
    return this.deps.readModel.getMergePreview(args.baseRef, args.headRef);
  }

  public async getMergePreviewByOids(args: { baseOid: string; headOid: string }): Promise<unknown> {
    await this.deps.prepare();
    return this.deps.readModel.getMergePreviewByOids(args.baseOid, args.headOid);
  }

  public async resolveRef(ref: string): Promise<string | null> {
    await this.deps.prepare();
    return this.deps.git.resolveRef(ref);
  }

  public async hasObject(oid: string): Promise<boolean> {
    await this.deps.prepare();
    return this.deps.git.hasObject(oid);
  }

  public async isAncestor(ancestor: string, oid: string): Promise<boolean> {
    await this.deps.prepare();
    if (!/^[0-9a-f]{40}$/.test(ancestor) || !/^[0-9a-f]{40}$/.test(oid)) return false;
    try {
      return await this.deps.git.isAncestor(ancestor, oid);
    } catch {
      return false;
    }
  }

  public async getPullDiff(args: { baseOid: string | null; headOid: string }): Promise<unknown> {
    await this.deps.prepare();
    return this.deps.readModel.getPullDiff(args.baseOid, args.headOid, this.getMaxMergeDiffFiles());
  }

  public async getBlame(args: { ref?: string; filepath: string }): Promise<unknown> {
    await this.deps.prepare();
    if (!args.filepath || args.filepath.length > 500) return null;
    return this.deps.readModel.getBlame(args.ref ?? 'HEAD', args.filepath);
  }

  public async exportPack(wants: string[]): Promise<{ oids: string[]; pack: Uint8Array | null }> {
    await this.deps.prepare();
    if (wants.length === 0) return { oids: [], pack: null };
    const limits = this.deps.getLimits?.() ?? { maxObjects: 10_000, maxPackBytes: 52_428_800 };
    const { oids } = await this.deps.git.collectObjectsForPack(wants, [], { maxObjects: limits.maxObjects });
    if (oids.length === 0) return { oids, pack: null };
    const pack = (await this.deps.git.packObjects(oids)) as Uint8Array | undefined;
    if (!pack || pack.byteLength === 0) return { oids, pack: null };
    if (pack.byteLength > limits.maxPackBytes) {
      throw new PackLimitError(`pack too large: ${pack.byteLength} > ${limits.maxPackBytes} bytes`);
    }
    return { oids, pack };
  }

  public async getReleaseAsset(args: { releaseId: string; assetId: string }): Promise<Uint8Array | null> {
    await this.deps.prepare();
    if (!this.deps.releaseAssets) return null;
    return this.deps.releaseAssets.load(args);
  }
}

export { RepoQueryRpc };
