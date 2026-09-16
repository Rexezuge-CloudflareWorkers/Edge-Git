import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';

const logger = {
  warn: (...args: unknown[]): void => console.warn('[WARN] [MergeService]', ...args),
  error: (...args: unknown[]): void => console.error('[ERROR] [MergeService]', ...args),
};

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

interface MergeAuthor {
  name: string;
  email: string;
}

type MergeOutcome =
  | { type: 'already-merged'; commitOid: string }
  | { type: 'fast-forward'; commitOid: string }
  | { type: 'merge-commit'; commitOid: string }
  | { type: 'conflict'; conflicts: string[]; reason?: string };

interface MergePreview {
  baseOid: string;
  headOid: string;
  mergeBase: string | null;
  alreadyMerged: boolean;
  canFastForward: boolean;
}

const BRANCH_SEGMENT_RE = /^[\w.-]+$/;

function hasIllegalBranchChar(branch: string): boolean {
  for (const ch of branch) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20) return true;
    if (code === 0x5c) return true;
    if ('~^:?*[@{['.includes(ch)) return true;
  }
  return false;
}

function isValidBranchName(branch: string): boolean {
  if (!branch || branch.length > 255) return false;
  if (branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')) return false;
  if (branch.includes('..') || branch.includes('//')) return false;
  if (hasIllegalBranchChar(branch)) return false;
  return branch.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && seg !== '@' && BRANCH_SEGMENT_RE.test(seg));
}

export class MergeService {
  private readonly fs: PromiseFsClient;
  private readonly gitdir: string;
  private readonly dir: string;
  private cache: object = {};

  constructor(fs: PromiseFsClient, gitdir: string, dir = '/tmp-merge-wd') {
    this.fs = fs;
    this.gitdir = gitdir;
    this.dir = dir;
  }

  public clearCache(): void {
    this.cache = {};
  }

  private async removeWorkdir(workdir: string): Promise<void> {
    const promises = this.fs.promises as unknown as { rm?: (p: string, o?: object) => Promise<void>; rmdir?: (p: string, o?: object) => Promise<void> };
    try {
      if (typeof promises.rm === 'function') {
        await promises.rm(workdir, { recursive: true, force: true });
        return;
      }
      await this.fs.promises.rmdir(workdir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }

  public async resolveRef(ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fs, gitdir: this.gitdir, ref });
    } catch {
      return null;
    }
  }

  public async findMergeBase(oids: string[]): Promise<string | null> {
    try {
      const bases = await git.findMergeBase({ fs: this.fs, gitdir: this.gitdir, oids, cache: this.cache });
      return bases[0] ?? null;
    } catch (error) {
      logger.warn(`(find-merge-base) failed for ${oids.join(',')}: ${String(error)}`);
      return null;
    }
  }

  public async isAncestor(ancestor: string, oid: string): Promise<boolean> {
    try {
      return await git.isDescendent({ fs: this.fs, gitdir: this.gitdir, oid, ancestor, cache: this.cache });
    } catch {
      return false;
    }
  }

  public async getPreview(baseRef: string, headRef: string): Promise<MergePreview | null> {
    const [baseOid, headOid] = await Promise.all([this.resolveRef(baseRef), this.resolveRef(headRef)]);
    if (!baseOid || !headOid) return null;
    return this.getPreviewByOids(baseOid, headOid);
  }

  /**
   * Oid-based preview for cross-repo (cross-DO) pull requests, where the head
   * ref lives in another Durable Object and its objects were materialized
   * into this repo via `importPack` beforehand.
   */
  public async getPreviewByOids(baseOid: string, headOid: string): Promise<MergePreview | null> {
    if (!/^[0-9a-f]{40}$/.test(baseOid) || !/^[0-9a-f]{40}$/.test(headOid)) return null;
    if (baseOid === headOid) {
      return { baseOid, headOid, mergeBase: baseOid, alreadyMerged: true, canFastForward: true };
    }
    const mergeBase = await this.findMergeBase([baseOid, headOid]);
    if (!mergeBase) return { baseOid, headOid, mergeBase: null, alreadyMerged: false, canFastForward: false };
    if (mergeBase === headOid) return { baseOid, headOid, mergeBase, alreadyMerged: true, canFastForward: false };
    return { baseOid, headOid, mergeBase, alreadyMerged: false, canFastForward: mergeBase === baseOid };
  }

  public async deleteBranch(branch: string): Promise<void> {
    if (!isValidBranchName(branch)) throw new Error(`invalid branch name: ${branch}`);
    await git.deleteBranch({ fs: this.fs, gitdir: this.gitdir, ref: branch });
  }

  public async mergeBranches(input: { baseBranch: string; headOid: string; author: MergeAuthor; message?: string }): Promise<MergeOutcome> {
    if (!isValidBranchName(input.baseBranch)) throw new Error(`invalid base branch: ${input.baseBranch}`);
    if (!/^[0-9a-f]{40}$/.test(input.headOid)) throw new Error('invalid head oid');
    const baseRef = `refs/heads/${input.baseBranch}`;
    const baseOid = await this.resolveRef(baseRef);
    if (!baseOid) throw new Error(`base branch not found: ${input.baseBranch}`);
    if (baseOid === input.headOid) return { type: 'already-merged', commitOid: baseOid };

    const mergeBase = await this.findMergeBase([baseOid, input.headOid]);
    if (mergeBase === input.headOid) return { type: 'already-merged', commitOid: baseOid };
    if (mergeBase === baseOid) {
      // Fast-forward: head is strictly ahead.
      await git.writeRef({ fs: this.fs, gitdir: this.gitdir, ref: baseRef, value: input.headOid, force: true });
      return { type: 'fast-forward', commitOid: input.headOid };
    }

    // True 3-way merge. isomorphic-git merge works on bare repos via
    // gitdir; dir only needs to exist for index/workdir plumbing.
    const suffix = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const workdir = `${this.dir}-${suffix}`;
    try {
      await this.fs.promises.mkdir(workdir, { recursive: true });
    } catch {
      // best-effort; merge may still proceed
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const author = { ...input.author, timestamp, timezoneOffset: 0 };
    try {
      const result = await git.merge({
        fs: this.fs,
        dir: workdir,
        gitdir: this.gitdir,
        ours: baseRef,
        theirs: input.headOid,
        author,
        committer: author,
        fastForward: true,
        message: input.message ?? `Merge branch '${input.baseBranch}' head ${input.headOid.slice(0, 7)}`,
        cache: this.cache,
      });
      if (result.alreadyMerged) return { type: 'already-merged', commitOid: result.oid ?? baseOid };
      if (result.fastForward) {
        if (!result.oid) throw new Error('fast-forward merge produced no commit');
        return { type: 'fast-forward', commitOid: result.oid };
      }
      if (!result.oid) throw new Error('merge produced no commit');
      return { type: 'merge-commit', commitOid: result.oid };
    } catch (error) {
      if (error instanceof Error && (error.name === 'MergeConflictError' || (error as { code?: string }).code === 'MergeConflictError')) {
        const filepaths = (error as { data?: { filepaths?: string[] } }).data?.filepaths ?? [];
        // Abort partial index state: reset index lock by clearing cache; isomorphic-git
        // with abortOnConflict=true (default) leaves the branch untouched.
        return { type: 'conflict', conflicts: filepaths };
      }
      if (error instanceof Error && (error.name === 'MergeNotSupportedError' || (error as { code?: string }).code === 'MergeNotSupportedError')) {
        return { type: 'conflict', conflicts: [], reason: 'criss-cross merges are not supported' };
      }
      logger.error(`(merge) failed ${baseRef} <- ${input.headOid}: ${String(error)}`);
      throw error;
    } finally {
      await this.removeWorkdir(workdir);
    }
  }
}
