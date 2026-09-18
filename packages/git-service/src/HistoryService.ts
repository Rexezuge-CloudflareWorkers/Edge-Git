import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';
import { diffText } from './DiffHunks';
import type { DiffHunk } from './DiffHunks';
import { TreeReader } from './TreeReader';

const logger = {
  warn: (...args: unknown[]): void => console.warn('[WARN] [GitService]', ...args),
  info: (...args: unknown[]): void => console.info('[INFO] [GitService]', ...args),
  error: (...args: unknown[]): void => console.error('[ERROR] [GitService]', ...args),
};

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

type TextFile = { isBinary: boolean; content: string | null };

type FileStateChange = {
  type: 'add' | 'modify' | 'remove';
  path: string;
  old: TextFile | null;
  new: TextFile | null;
};

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
  private cache: object = {};
  private cacheCreatedAt = Date.now();
  private readonly trees: TreeReader;

  constructor(fs: PromiseFsClient, gitdir: string) {
    this.fs = fs;
    this.gitdir = gitdir;
    this.trees = new TreeReader(fs, gitdir, () => this.cache);
  }

  public clearCache(): void {
    this.cache = {};
    this.cacheCreatedAt = Date.now();
  }

  public ensureFreshCache(ttlSeconds: number): void {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return;
    if (Date.now() - this.cacheCreatedAt > ttlSeconds * 1000) {
      this.clearCache();
    }
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
    type File =
      | {
          isBinary: false;
          content: string;
        }
      | {
          isBinary: true;
          content: null;
        };

    type Change = {
      type: 'add' | 'modify' | 'remove';
      path: string;
      old: File | null;
      new: File | null;
    };

    const data = await git.walk({
      fs: this.fs,
      gitdir: this.gitdir,
      trees: [git.TREE({ ref: oldCommit }), git.TREE({ ref: newCommit })],
      map: async (filepath, [A, B]): Promise<Change | undefined> => {
        if (filepath === '.') {
          return;
        }

        const Atype = A ? await A.type() : null;
        const Btype = B ? await B.type() : null;

        if (Atype === 'tree' || Btype === 'tree') {
          return;
        }

        const Aoid = A ? await A.oid() : null;
        const Boid = B ? await B.oid() : null;

        if (Aoid === null && Boid === null) {
          logger.warn(`(get-file-state-changes): Both A and B are null for path ${filepath}`);
          return;
        }
        const type: 'equal' | 'modify' | 'add' | 'remove' =
          Aoid === null ? 'add' : Boid === null ? 'remove' : Aoid === Boid ? 'equal' : 'modify';

        if (type === 'equal') {
          return;
        }

        const oldContent = await A?.content();
        const newContent = await B?.content();

        const isOldBinary = oldContent && this.detectBinary(oldContent);
        const isNewBinary = newContent && this.detectBinary(newContent);

        let oldFile: File | null = null;

        if (isOldBinary) {
          oldFile = { isBinary: true, content: null };
        } else if (oldContent) {
          oldFile = {
            isBinary: false,
            content: new TextDecoder().decode(oldContent),
          };
        }

        let newFile: File | null = null;

        if (isNewBinary) {
          newFile = { isBinary: true, content: null };
        } else if (newContent) {
          newFile = {
            isBinary: false,
            content: new TextDecoder().decode(newContent),
          };
        }

        return {
          type,
          path: filepath,
          old: oldFile,
          new: newFile,
        };
      },
    });
    return data as Change[];
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
    const changes = (await this.getFileStateChanges(diffBase, headOid)) as FileStateChange[];
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
   * commit that last touched it. Walks file history oldest-first and replays
   * hunks: lines surviving from an older version keep their commit, new lines
   * take the current commit. Capped to 5000 lines / 200 commits.
   */
  async getBlame(ref: string, filepath: string): Promise<{ oid: string; lines: Array<{ line: number; commitOid: string; author: string; content: string }>; truncated: boolean } | null> {
    let resolved: string | null = null;
    try {
      resolved = await git.resolveRef({ fs: this.fs, gitdir: this.gitdir, ref });
    } catch {
      return null;
    }
    if (!resolved) return null;
    const current = await this.getBlob(resolved, filepath);
    if (!current || (current as { isBinary?: boolean }).isBinary) return null;
    const text = new TextDecoder().decode((current as { content: Uint8Array }).content);
    if (text.length > 200_000) return { oid: resolved, lines: [], truncated: true };
    const currentLines = text.split('\n');
    if (currentLines.length > 5000) return { oid: resolved, lines: [], truncated: true };
    let history: Array<{ oid: string; commit: { author: { name: string; email: string } } }>;
    try {
      history = await git.log({ fs: this.fs, gitdir: this.gitdir, ref, filepath, cache: this.cache });
    } catch {
      return null;
    }
    if (history.length === 0) return null;
    // eslint-disable-next-line unicorn/no-array-reverse
    const oldestFirst = [...history].reverse().slice(-200);
    // Start: all lines belong to the oldest commit touching the file, then
    // walk forward attributing changed lines to newer commits via simple
    // longest-common-subsequence-free heuristic (position-anchored diff).
    const attribution: Array<{ commitOid: string; author: string }> = currentLines.map(() => ({
      commitOid: oldestFirst[0].oid,
      author: oldestFirst[0].commit.author.email || oldestFirst[0].commit.author.name,
    }));
    const fileAt = async (oid: string): Promise<string[] | null> => {
      try {
        const { blob } = await git.readBlob({ fs: this.fs, gitdir: this.gitdir, oid, filepath, cache: this.cache });
        if (this.detectBinary(blob)) return null;
        return new TextDecoder().decode(blob).split('\n');
      } catch {
        return null;
      }
    };
    let previous = await fileAt(oldestFirst[0].oid);
    for (const entry of oldestFirst.slice(1)) {
      const next = await fileAt(entry.oid);
      if (!next || !previous) {
        previous = next;
        continue;
      }
      // Lines present in `next` but not at the same position in `previous`
      // are attributed to `entry`; surviving lines keep older attribution.
      // Rebuild attribution anchored to the newest content at the end.
      if (next.length === currentLines.length) {
        for (const [i, line] of next.entries()) {
          if (previous[i] !== line) attribution[i] = { commitOid: entry.oid, author: entry.commit.author.email || entry.commit.author.name };
        }
      }
      previous = next;
    }
    // Anchor to current content length (history tip should equal ref).
    const lines = currentLines.map((content, i) => ({ line: i + 1, commitOid: attribution[i]?.commitOid ?? resolved ?? '', author: attribution[i]?.author ?? '', content }));
    return { oid: resolved, lines, truncated: false };
  }
}
