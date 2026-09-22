import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';
import { diffText } from './DiffHunks';
import type { DiffHunk } from './DiffHunks';
import { GitCache } from './GitCache';
import { TreeReader } from './TreeReader';
import { TreeDiffer } from './TreeDiffer';
import type { FileStateChange } from './TreeDiffer';
import { BlameReader } from './BlameReader';

const logger = {
  warn: (...args: unknown[]): void => console.warn('[WARN] [GitService]', ...args),
  info: (...args: unknown[]): void => console.info('[INFO] [GitService]', ...args),
  error: (...args: unknown[]): void => console.error('[ERROR] [GitService]', ...args),
};

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

export interface FileDiffWithHunks {
  path: string;
  type: 'add' | 'modify' | 'remove';
  binary: boolean;
  tooLarge: boolean;
  hunks: DiffHunk[];
}

export class HistoryService {
  private readonly fs: PromiseFsClient;
  private readonly gitdir: string;
  private readonly cacheHolder = new GitCache();
  private readonly trees: TreeReader;
  private readonly differ: TreeDiffer;
  private readonly blamer: BlameReader;

  private get cache(): object {
    return this.cacheHolder.getCache();
  }

  constructor(fs: PromiseFsClient, gitdir: string) {
    this.fs = fs;
    this.gitdir = gitdir;
    this.trees = new TreeReader(fs, gitdir, () => this.cacheHolder.getCache());
    this.differ = new TreeDiffer(fs, gitdir, (content) => this.trees.detectBinary(content));
    this.blamer = new BlameReader(fs, gitdir, this.trees, () => this.cacheHolder.getCache());
  }

  public clearCache(): void {
    this.cacheHolder.clearCache();
  }

  public ensureFreshCache(ttlSeconds: number): void {
    this.cacheHolder.ensureFreshCache(ttlSeconds);
  }

  async getLastCommit(branch: string): Promise<git.ReadCommitResult | undefined> {
    try {
      const [commit] = await git.log({
        fs: this.fs,
        gitdir: this.gitdir,
        ref: branch,
        depth: 1,
        cache: this.cache,
      });

      return commit ?? undefined;
    } catch (error) {
      logger.warn(`(get-last-commit) Failed to get last commit for branch ${branch}: ${String(error)}`);
      return undefined;
    }
  }

  async getLog({ ref, depth, filepath }: { ref?: string; depth?: number; filepath?: string }) {
    try {
      const commits = await git.log({
        fs: this.fs,
        gitdir: this.gitdir,
        cache: this.cache,
        ref,
        depth,
        filepath,
      });

      return commits;
    } catch (error) {
      logger.warn(`(get-log) Failed to get log for ref ${ref}: ${String(error)}`);
      return [];
    }
  }

  async getTree(resolvedRef: string, path = '') {
    return this.trees.getTree(resolvedRef, path);
  }

  async getBlob(resolvedRef: string, filepath: string) {
    return this.trees.getBlob(resolvedRef, filepath);
  }

  getBlobSize(content: Uint8Array): number {
    return this.trees.getBlobSize(content);
  }

  detectBinary(content: Uint8Array): boolean {
    return this.trees.detectBinary(content);
  }

  async getFileStateChanges(oldCommit: string | undefined, newCommit: string | undefined) {
    return this.differ.diffTrees(oldCommit, newCommit);
  }

  async getCommit(commitOid: string) {
    try {
      const commit = await git.readCommit({
        fs: this.fs,
        gitdir: this.gitdir,
        cache: this.cache,
        oid: commitOid,
      });
      if (!commit.commit.parent || commit.commit.parent.length === 0) {
        logger.info(`(get-commit): Commit ${commitOid} is a root commit. Comparing with empty tree.`);
        return {
          commit,
          changes: await this.getFileStateChanges(undefined, commitOid),
        };
      }

      const parentOid = commit.commit.parent[0];
      return {
        commit,
        changes: await this.getFileStateChanges(parentOid, commitOid),
      };
    } catch (error) {
      logger.error(`(get-commit) Failed to get commit changes for ${commitOid}: ${String(error)}`);
      return {
        commit: null,
        changes: [],
      };
    }
  }

  private async resolveDiffRef(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fs, gitdir: this.gitdir, ref });
    } catch {
      return null;
    }
  }

  private toFileDiff(change: FileStateChange): FileDiffWithHunks {
    const binary = (change.old?.isBinary ?? false) || (change.new?.isBinary ?? false);
    if (binary) {
      return { path: change.path, type: change.type, binary: true, tooLarge: false, hunks: [] };
    }
    const { tooLarge, hunks } = diffText(change.old?.content ?? null, change.new?.content ?? null);
    return { path: change.path, type: change.type, binary: false, tooLarge, hunks };
  }

  // Single-commit view: commit metadata plus per-file unified hunks
  // (vs the first parent, or vs the empty tree for root commits).
  async getCommitDiff(commitOid: string, maxFiles: number) {
    const { commit, changes } = (await this.getCommit(commitOid)) as { commit: unknown; changes: FileStateChange[] };
    if (!commit) return { commit: null, truncated: false, files: [] };
    return {
      commit,
      truncated: changes.length > maxFiles,
      files: changes.slice(0, maxFiles).map((c) => this.toFileDiff(c)),
    };
  }

  // Compare view: three-dot diff of `headRef` against the merge-base with
  // `baseRef` (falls back to two-dot when no common history exists).
  async getCompareDiff(baseRef: string, headRef: string, maxFiles: number) {
    const [baseOid, headOid] = await Promise.all([this.resolveDiffRef(baseRef), this.resolveDiffRef(headRef)]);
    if (!baseOid || !headOid) return null;
    let mergeBase: string | null = null;
    try {
      const bases = await git.findMergeBase({ fs: this.fs, gitdir: this.gitdir, oids: [baseOid, headOid], cache: this.cache });
      mergeBase = bases[0] ?? null;
    } catch {
      mergeBase = null;
    }
    const diffBase = mergeBase ?? baseOid;
    const changes = await this.getFileStateChanges(diffBase, headOid);
    return {
      baseOid,
      headOid,
      mergeBase,
      truncated: changes.length > maxFiles,
      files: changes.slice(0, maxFiles).map((c) => this.toFileDiff(c)),
    };
  }

  /**
   * Blame v1: attribute each line of `filepath` at `ref` to the most recent
   * commit that last touched it. Delegates to `BlameReader` (SRP); see that
   * class for the walk-forward attribution algorithm and caps.
   */
  async getBlame(
    ref: string,
    filepath: string,
  ): Promise<{
    oid: string;
    lines: Array<{ line: number; commitOid: string; author: string; content: string }>;
    truncated: boolean;
  } | null> {
    return this.blamer.blame(ref, filepath);
  }
}
