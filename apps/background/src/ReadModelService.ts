import type { GitService } from '@edge-git/git-service';

// Read-model queries served over DO RPC (branches/tree/blob/commits).
// Lifecycle (ensure initialized, cache refresh) stays with RepoWorker via
// prepare(); this service only runs git queries.
class ReadModelService {
  constructor(private readonly git: GitService) {}

  public async getLatestCommit(branch = 'HEAD'): Promise<unknown> {
    return this.git.getLastCommit(branch);
  }

  public async getCommits(args: { ref?: string; depth?: number; filepath?: string }): Promise<unknown> {
    const latestCommit = (await this.git.getLastCommit(args.ref ?? 'HEAD')) as { oid: string } | null;
    if (!latestCommit) {
      return [];
    }
    return this.git.getLog(args);
  }

  public async getBranches(): Promise<{ branches: string[]; currentBranch: string | null }> {
    const branches = await this.git.listBranches();
    const currentBranch = await this.git.currentBranch();
    return { branches, currentBranch: currentBranch ?? null };
  }

  public async getTree(args: { ref?: string; path?: string }): Promise<unknown> {
    const { ref, path } = args;
    const resolvedRef = await this.git.resolveRef(ref);
    if (!resolvedRef) {
      return [];
    }
    const tree = await this.git.getTree(resolvedRef, path);
    const data = await Promise.all(
      (tree as Array<{ path: string }>).map(async (item) => {
        const lastCommit = (await this.git.getLog({
          ref,
          depth: 1,
          filepath: path ? `${path}/${item.path}` : item.path,
        })) as Array<unknown>;
        return { ...item, lastCommit: lastCommit[0] || null };
      }),
    );
    return data;
  }

  public async getBlob(args: { ref?: string; filepath: string }): Promise<unknown> {
    const { ref, filepath } = args;
    const resolvedRef = await this.git.resolveRef(ref);
    if (!resolvedRef) {
      return null;
    }
    const blob = await this.git.getBlob(resolvedRef, filepath);
    if (!blob) return null;
    // Serialize Uint8Array safely as base64
    const content = (blob as { content?: Uint8Array }).content;
    if (content instanceof Uint8Array) {
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < content.length; i += chunk) {
        binary += String.fromCodePoint(...content.subarray(i, i + chunk));
      }
      return { ...(blob as object), contentBase64: btoa(binary) };
    }
    return blob;
  }

  public async getCommit(commitOid: string): Promise<unknown> {
    return this.git.getCommit(commitOid);
  }

  public async getMergePreview(baseRef: string, headRef: string): Promise<unknown> {
    return this.git.getMergePreview(baseRef, headRef);
  }

  public async getPullDiff(baseOid: string | null, headOid: string, maxFiles: number): Promise<unknown> {
    if (!baseOid) {
      const commit = (await this.git.getCommit(headOid)) as { changes?: unknown } | null;
      const changes = Array.isArray((commit as { changes?: unknown })?.changes) ? ((commit as { changes: unknown[] }).changes) : [];
      return { mergeBase: null, truncated: changes.length > maxFiles, changes: changes.slice(0, maxFiles) };
    }
    const mergeBase = await this.git.findMergeBase([baseOid, headOid]);
    const diffBase = mergeBase ?? baseOid;
    const changes = (await this.git.getFileStateChanges(diffBase, headOid)) as unknown[];
    return { mergeBase, truncated: changes.length > maxFiles, changes: changes.slice(0, maxFiles) };
  }
}

export { ReadModelService };
