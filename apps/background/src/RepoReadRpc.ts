import { RepoMutationRpc } from './RepoMutationRpc';
import { RepoQueryRpc } from './RepoQueryRpc';
import type { RepoRpcDeps } from './RepoRpcDeps';

type RepoReadRpcDeps = RepoRpcDeps;

/**
 * Read-model RPC facade for `RepoWorker`.
 * Queries live in `RepoQueryRpc`, mutations in `RepoMutationRpc`; this class
 * preserves the original single-`reads` surface so the Durable Object and
 * all callers are untouched.
 */
class RepoReadRpc {
  private readonly queries: RepoQueryRpc;
  private readonly mutations: RepoMutationRpc;

  constructor(deps: RepoReadRpcDeps) {
    this.queries = new RepoQueryRpc(deps);
    this.mutations = new RepoMutationRpc(deps);
  }

  public async listRefs(): Promise<{ refs: Array<{ ref: string; oid: string }>; symbolicHead: string | null }> {
    return this.queries.listRefs();
  }

  public async getLatestCommit(branch = 'HEAD'): Promise<unknown> {
    return this.queries.getLatestCommit(branch);
  }

  public async getCommits(args: { ref?: string; depth?: number; filepath?: string }): Promise<unknown> {
    return this.queries.getCommits(args);
  }

  public async getBranches(): Promise<{ branches: string[]; currentBranch: string | null }> {
    return this.queries.getBranches();
  }

  public async createBranch(args: { name: string; fromRef?: string }): Promise<unknown> {
    return this.mutations.createBranch(args);
  }

  public async deleteBranchRef(branch: string): Promise<unknown> {
    return this.mutations.deleteBranchRef(branch);
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
    return this.mutations.commitFile(args);
  }

  public async setDefaultBranch(branch: string): Promise<unknown> {
    return this.mutations.setDefaultBranch(branch);
  }

  public async getTags(): Promise<
    Array<{ name: string; ref: string; oid: string; peeledOid: string | null; type: 'lightweight' | 'annotated' }>
  > {
    return this.queries.getTags();
  }

  public async getTree(args: { ref?: string; path?: string; withLastCommit?: boolean }): Promise<unknown> {
    return this.queries.getTree(args);
  }

  public async getBlob(args: { ref?: string; filepath: string }): Promise<unknown> {
    return this.queries.getBlob(args);
  }

  public async getOverview(args: {
    ref?: string;
    path?: string;
    depth?: number;
    includeTags?: boolean;
    includeReadme?: boolean;
  }): Promise<unknown> {
    return this.queries.getOverview(args);
  }

  public async listAllFiles(args: { ref?: string; maxFiles?: number }): Promise<Array<{ path: string; oid: string }>> {
    return this.queries.listAllFiles(args);
  }

  public async getCommit(commitOid: string): Promise<unknown> {
    return this.queries.getCommit(commitOid);
  }

  public async getCommitDiff(commitOid: string): Promise<unknown> {
    return this.queries.getCommitDiff(commitOid);
  }

  public async getCompare(args: { baseRef: string; headRef: string }): Promise<unknown> {
    return this.queries.getCompare(args);
  }

  public async getMergePreview(args: { baseRef: string; headRef: string }): Promise<unknown> {
    return this.queries.getMergePreview(args);
  }

  public async getMergePreviewByOids(args: { baseOid: string; headOid: string }): Promise<unknown> {
    return this.queries.getMergePreviewByOids(args);
  }

  public async resolveRef(ref: string): Promise<string | null> {
    return this.queries.resolveRef(ref);
  }

  public async hasObject(oid: string): Promise<boolean> {
    return this.queries.hasObject(oid);
  }

  public async isAncestor(ancestor: string, oid: string): Promise<boolean> {
    return this.queries.isAncestor(ancestor, oid);
  }

  public async updateRefs(updates: Array<{ ref: string; oldOid: string; newOid: string }>): Promise<unknown> {
    return this.mutations.updateRefs(updates);
  }

  public async exportPack(wants: string[]): Promise<{ oids: string[]; pack: Uint8Array | null }> {
    return this.queries.exportPack(wants);
  }

  public async importPack(pack: Uint8Array, refs?: Array<{ ref: string; oid: string }>): Promise<{ importedRefs: string[] }> {
    return this.mutations.importPack(pack, refs);
  }

  public async getPullDiff(args: { baseOid: string | null; headOid: string }): Promise<unknown> {
    return this.queries.getPullDiff(args);
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
    return this.mutations.mergePull(args);
  }

  public async deleteBranch(branch: string): Promise<{ deleted: boolean }> {
    return this.mutations.deleteBranch(branch);
  }

  public async getBlame(args: { ref?: string; filepath: string }): Promise<unknown> {
    return this.queries.getBlame(args);
  }

  public async storeReleaseAsset(args: { releaseId: string; assetId: string; bytes: Uint8Array }): Promise<unknown> {
    return this.mutations.storeReleaseAsset(args);
  }

  public async getReleaseAsset(args: { releaseId: string; assetId: string }): Promise<Uint8Array | null> {
    return this.queries.getReleaseAsset(args);
  }

  public async deleteReleaseAsset(args: { releaseId: string; assetId: string }): Promise<{ deleted: boolean }> {
    return this.mutations.deleteReleaseAsset(args);
  }

  public async deleteReleaseAssets(args: { releaseId: string }): Promise<{ deleted: number }> {
    return this.mutations.deleteReleaseAssets(args);
  }
}

export { RepoReadRpc };
export type { RepoReadRpcDeps };
