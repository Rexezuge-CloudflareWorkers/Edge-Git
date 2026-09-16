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

  public async getTags(): Promise<
    Array<{ name: string; ref: string; oid: string; peeledOid: string | null; type: 'lightweight' | 'annotated' }>
  > {
    const tags = await this.git.listTags();
    const enriched = await Promise.all(
      tags.map(async (t) => {
        const name = t.ref.startsWith('refs/tags/') ? t.ref.slice('refs/tags/'.length) : t.ref;
        const peeledOid: string | null = await this.git.peelTag(t.oid);
        const type: 'lightweight' | 'annotated' = peeledOid === null ? 'lightweight' : 'annotated';
        return { name, ref: t.ref, oid: t.oid, peeledOid, type };
      }),
    );
    enriched.sort((a, b) => a.name.localeCompare(b.name));
    return enriched;
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

  // Recursive file listing for the code search indexer. Breadth-first walk
  // capped by maxFiles (+ a dir-visit cap) so giant repos cannot blow the
  // DO wall-clock. Returns repo-relative paths with blob oids.
  public async listAllFiles(args: { ref?: string; maxFiles?: number }): Promise<Array<{ path: string; oid: string }>> {
    const maxFiles = Math.min(Math.max(args.maxFiles ?? 200, 1), 500);
    const resolvedRef = await this.git.resolveRef(args.ref);
    if (!resolvedRef) return [];
    const files: Array<{ path: string; oid: string }> = [];
    const queue: string[] = [''];
    let dirsVisited = 0;
    while (queue.length > 0 && files.length < maxFiles && dirsVisited < 200) {
      const dir = queue.shift();
      if (dir === undefined) break;
      dirsVisited += 1;
      const entries = await this.readTreeEntries(resolvedRef, dir);
      ReadModelService.collectEntries(entries, dir, queue, files, maxFiles);
    }
    return files;
  }

  private async readTreeEntries(resolvedRef: string, dir: string): Promise<Array<{ path: string; type: string; oid: string }>> {
    try {
      return await this.git.getTree(resolvedRef, dir);
    } catch {
      return [];
    }
  }

  private static collectEntries(
    entries: Array<{ path: string; type: string; oid: string }>,
    dir: string,
    queue: string[],
    files: Array<{ path: string; oid: string }>,
    maxFiles: number,
  ): void {
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const fullPath = dir ? `${dir}/${entry.path}` : entry.path;
      if (entry.type === 'tree') {
        queue.push(fullPath);
      } else if (entry.type === 'blob') {
        files.push({ path: fullPath, oid: entry.oid });
      }
    }
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

  public async getCommitDiff(commitOid: string, maxFiles: number): Promise<unknown> {
    return this.git.getCommitDiff(commitOid, maxFiles);
  }

  public async getCompare(baseRef: string, headRef: string, maxFiles: number): Promise<unknown> {
    return this.git.getCompareDiff(baseRef, headRef, maxFiles);
  }

  public async getMergePreview(baseRef: string, headRef: string): Promise<unknown> {
    return this.git.getMergePreview(baseRef, headRef);
  }

  public async getMergePreviewByOids(baseOid: string, headOid: string): Promise<unknown> {
    return this.git.getMergePreviewByOids(baseOid, headOid);
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
