import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';
import { isValidBranchName } from './MergeService';

const logger = {
  warn: (...args: unknown[]): void => console.warn('[WARN] [WriteService]', ...args),
};

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
export const MAX_FILE_PATH_LENGTH = 1024;
export const MAX_PATH_SEGMENTS = 64;

export interface FileAuthor {
  name: string;
  email: string;
}

export interface CommitFileInput {
  branch: string;
  path: string;
  // File bytes for create/update; `null` deletes the file.
  content: Uint8Array | null;
  message?: string;
  // Branch tip the writer based their edit on; mismatch yields 409.
  expectedOid?: string | null;
  author: FileAuthor;
  maxFileBytes?: number;
}

export type CommitFileResult =
  { ok: true; commitOid: string; created: boolean; deleted: boolean } | { ok: false; error: string; status: 400 | 404 | 409 | 413 };

interface TreeEntry {
  mode: string;
  path: string;
  oid: string;
  type: 'blob' | 'tree' | 'commit';
}

function detectBinary(content: Uint8Array): boolean {
  const bytesToCheck = Math.min(8000, content.length);
  for (let i = 0; i < bytesToCheck; i += 1) {
    if (content[i] === 0) return true;
  }
  return false;
}

/**
 * Split and validate a repo-relative file path. Returns the segments, or an
 * error message when the path is unsafe (traversal, `.git`, empty parts).
 */
export function splitFilePath(path: string): { ok: true; segments: string[] } | { ok: false; error: string } {
  if (!path) return { ok: false, error: 'path is required' };
  if (path.length > MAX_FILE_PATH_LENGTH) return { ok: false, error: `path too long (max ${MAX_FILE_PATH_LENGTH} chars)` };
  if (path.startsWith('/') || path.endsWith('/') || path.includes('//') || path.includes('\0')) {
    return { ok: false, error: `invalid path: ${path}` };
  }
  const segments = path.split('/');
  if (segments.length > MAX_PATH_SEGMENTS) return { ok: false, error: 'path has too many segments' };
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..' || seg.toLowerCase() === '.git' || seg.length > 255) {
      return { ok: false, error: `invalid path: ${path}` };
    }
  }
  return { ok: true, segments };
}

export class WriteService {
  private readonly fs: PromiseFsClient;
  private readonly gitdir: string;

  constructor(fs: PromiseFsClient, gitdir: string) {
    this.fs = fs;
    this.gitdir = gitdir;
  }

  private async resolveRef(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fs, gitdir: this.gitdir, ref });
    } catch {
      return null;
    }
  }

  private async pathExistsAt(commitOid: string, filepath: string): Promise<boolean> {
    try {
      await git.readBlob({ fs: this.fs, gitdir: this.gitdir, oid: commitOid, filepath });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Rebuild the tree for `segments` with the leaf set to `blobOid` (or
   * removed when `blobOid` is null). Returns the new tree oid, or null when
   * the tree becomes empty. Sibling entries keep their modes.
   */
  private async updateTree(treeOid: string | null, segments: string[], blobOid: string | null, leafMode: string): Promise<string | null> {
    let entries: TreeEntry[] = [];
    if (treeOid) {
      try {
        const { tree } = await git.readTree({ fs: this.fs, gitdir: this.gitdir, oid: treeOid });
        entries = tree;
      } catch (error) {
        logger.warn(`(commit-file) failed to read tree ${treeOid}: ${String(error)}`);
        throw new Error('failed to read current tree');
      }
    }
    const [head, ...rest] = segments;
    const keptEntries = entries.filter((e) => e.path !== head);
    if (rest.length === 0) {
      const kept = entries.filter((e) => e.path !== head);
      if (blobOid) {
        const existing = entries.find((e) => e.path === head);
        kept.push({ mode: existing?.type === 'blob' ? existing.mode : leafMode, path: head, oid: blobOid, type: 'blob' });
      }
      if (kept.length === 0) return null;
      return git.writeTree({ fs: this.fs, gitdir: this.gitdir, tree: kept });
    }
    const sub = entries.find((e) => e.path === head);
    if (sub && sub.type !== 'tree') {
      throw new Error(`path conflicts with an existing file: ${head}`);
    }
    const newSubOid = await this.updateTree(sub?.oid ?? null, rest, blobOid, leafMode);
    if (newSubOid) {
      keptEntries.push({ mode: '040000', path: head, oid: newSubOid, type: 'tree' });
    }
    if (keptEntries.length === 0) return null;
    return git.writeTree({ fs: this.fs, gitdir: this.gitdir, tree: keptEntries });
  }

  /**
   * Commit a single file create/update/delete on `branch` using git plumbing
   * (no workdir checkout, HEAD untouched). Results are discriminated unions
   * — never throws — so they survive Durable Object RPC boundaries.
   */
  public async commitFile(input: CommitFileInput): Promise<CommitFileResult> {
    if (!isValidBranchName(input.branch)) {
      return { ok: false, error: `invalid branch name: ${input.branch}`, status: 400 };
    }
    const split = splitFilePath(input.path);
    if (!split.ok) return { ok: false, error: split.error, status: 400 };
    const message = (input.message ?? '').trim();
    if (!message) return { ok: false, error: 'message is required', status: 400 };
    if (message.length > 1000) return { ok: false, error: 'message too long (max 1000 chars)', status: 400 };
    const authorName = (input.author?.name ?? '').trim();
    const authorEmail = (input.author?.email ?? '').trim();
    if (!authorName || authorName.length > 255 || !authorEmail.includes('@') || authorEmail.length > 320) {
      return { ok: false, error: 'invalid author', status: 400 };
    }
    const maxFileBytes = input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    if (input.content !== null) {
      if (input.content.byteLength > maxFileBytes) {
        return { ok: false, error: `file too large (max ${maxFileBytes} bytes)`, status: 413 };
      }
      if (detectBinary(input.content)) {
        return { ok: false, error: 'binary files cannot be edited in the web editor', status: 400 };
      }
    }

    const branchRef = `refs/heads/${input.branch}`;
    const baseOid = await this.resolveRef(branchRef);
    const expected = input.expectedOid;
    const expectedMismatch =
      expected !== undefined &&
      expected !== null &&
      (!/^[0-9a-f]{40}$/i.test(expected) || (baseOid ?? '').toLowerCase() !== expected.toLowerCase());
    if (expectedMismatch) {
      return { ok: false, error: 'branch has changed since you loaded it; reload and try again', status: 409 };
    }
    if (!baseOid) {
      // Missing branch: only an unborn repo (no HEAD yet) may start a new
      // history via web create; otherwise the branch simply does not exist.
      const head = await this.resolveRef('HEAD');
      if (head) return { ok: false, error: 'branch not found', status: 404 };
      if (input.content === null) return { ok: false, error: 'file not found', status: 404 };
      if (input.expectedOid) {
        return { ok: false, error: 'branch has changed since you loaded it; reload and try again', status: 409 };
      }
    }

    const filepath = split.segments.join('/');
    const existed = baseOid ? await this.pathExistsAt(baseOid, filepath) : false;
    if (!existed && input.content === null) {
      return { ok: false, error: 'file not found', status: 404 };
    }

    let baseTreeOid: string | null = null;
    if (baseOid) {
      try {
        const { commit } = await git.readCommit({ fs: this.fs, gitdir: this.gitdir, oid: baseOid });
        baseTreeOid = commit.tree;
      } catch (error) {
        logger.warn(`(commit-file) failed to read base commit ${baseOid}: ${String(error)}`);
        return { ok: false, error: 'failed to read branch tip', status: 400 };
      }
    }

    let blobOid: string | null = null;
    if (input.content !== null) {
      try {
        blobOid = await git.writeBlob({ fs: this.fs, gitdir: this.gitdir, blob: input.content });
      } catch (error) {
        logger.warn(`(commit-file) failed to write blob: ${String(error)}`);
        return { ok: false, error: 'failed to write file content', status: 400 };
      }
    }

    let newTreeOid: string | null;
    try {
      newTreeOid = await this.updateTree(baseTreeOid, split.segments, blobOid, '100644');
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'failed to update tree', status: 400 };
    }
    // Deleting the last file leaves an empty tree (git's well-known empty-tree).
    const tree = newTreeOid ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

    if (baseOid && blobOid) {
      // No-op fast path: identical content rewrites the same tree.
      try {
        const { commit } = await git.readCommit({ fs: this.fs, gitdir: this.gitdir, oid: baseOid });
        if (commit.tree === tree) {
          return { ok: true, commitOid: baseOid, created: false, deleted: false };
        }
      } catch {
        // fall through to commit
      }
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const author = { name: authorName, email: authorEmail, timestamp, timezoneOffset: 0 };
    let commitOid: string;
    try {
      commitOid = await git.writeCommit({
        fs: this.fs,
        gitdir: this.gitdir,
        commit: { message, tree, parent: baseOid ? [baseOid] : [], author, committer: author },
      });
      await git.writeRef({ fs: this.fs, gitdir: this.gitdir, ref: branchRef, value: commitOid, force: true });
      if (!baseOid) {
        // First commit: point unborn HEAD at the new branch.
        try {
          await git.writeRef({ fs: this.fs, gitdir: this.gitdir, ref: 'HEAD', value: branchRef, force: true, symbolic: true });
        } catch {
          // best-effort; the branch ref itself is already correct
        }
      }
    } catch (error) {
      logger.warn(`(commit-file) failed to commit ${filepath}: ${String(error)}`);
      return { ok: false, error: 'failed to create commit', status: 400 };
    }
    return { ok: true, commitOid, created: !existed, deleted: input.content === null };
  }
}
