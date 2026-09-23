import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';
import type { RefUpdateResult } from '@edge-git/git-protocol';
import { branchRefFor, classifyRefCommand, isValidBranchName } from './RefValidation';
import { parseSymbolicHead } from './RefParsers';
import { RefUpdatePlanner } from './RefUpdatePlanner';

const logger = {
  warn: (...args: unknown[]): void => console.warn('[WARN] [GitService]', ...args),
  info: (...args: unknown[]): void => console.info('[INFO] [GitService]', ...args),
  error: (...args: unknown[]): void => console.error('[ERROR] [GitService]', ...args),
};

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

// Bound parallel ref resolution so tag/branch bombs cannot fan out into
// unbounded git I/O. Matches `ReadModelService` fan-out discipline.
const MAX_REF_RESOLVE_CONCURRENCY = 10;
const OID_RE = /^[0-9a-f]{40}$/i;

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = Array.from({ length: items.length }, () => undefined as R);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item !== undefined) out[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

export class RefService {
  private readonly fs: PromiseFsClient;
  private readonly gitdir: string;

  constructor(fs: PromiseFsClient, gitdir: string) {
    this.fs = fs;
    this.gitdir = gitdir;
  }

  async initRepo() {
    await git.init({
      fs: this.fs,
      dir: this.gitdir,
      bare: true,
      defaultBranch: 'main',
    });
  }

  async listRefs() {
    let symbolicHead: string | null = null;
    const refs: Array<{ ref: string; oid: string }> = [];

    try {
      const headContent = await this.fs.promises.readFile(`${this.gitdir}/HEAD`, {
        encoding: 'utf8',
      });
      symbolicHead = parseSymbolicHead(headContent);
    } catch {
      logger.warn('(read-head-file) No HEAD found in repository.');
    }

    try {
      const headOid = await git.resolveRef({
        fs: this.fs,
        gitdir: this.gitdir,
        ref: 'HEAD',
      });
      refs.push({ ref: 'HEAD', oid: headOid });
    } catch {
      logger.warn('(resolve-head-ref) No HEAD ref found in repository.');
    }

    const [branches, tags] = await Promise.all([this.listBranchesWithOid(), this.listTags()]);

    refs.push(...branches, ...tags);

    return { refs, symbolicHead };
  }

  async listBranchesWithOid(): Promise<Array<{ ref: string; oid: string }>> {
    try {
      const branchRefs = await git.listBranches({
        fs: this.fs,
        gitdir: this.gitdir,
      });
      const packed = await this.loadPackedRefsMap();
      const branches = await mapWithConcurrency(branchRefs, MAX_REF_RESOLVE_CONCURRENCY, async (branch) => {
        const ref = `refs/heads/${branch}`;
        const oid = await this.resolveLooseOrPacked(ref, packed);
        return { ref, oid };
      });
      return branches.filter((b) => OID_RE.test(b.oid));
    } catch {
      return [];
    }
  }

  async listBranches() {
    try {
      const branchRefs = await git.listBranches({
        fs: this.fs,
        gitdir: this.gitdir,
      });
      return branchRefs;
    } catch (error) {
      logger.warn('(list-branches) Failed to list branches: ', error);
      return [];
    }
  }

  async currentBranch() {
    try {
      const branch = await git.currentBranch({
        fs: this.fs,
        gitdir: this.gitdir,
        fullname: false,
      });
      return branch ?? null;
    } catch (error) {
      logger.warn('(current-branch) Failed to get current branch: ', error);
      return null;
    }
  }

  // Branch lifecycle (create/delete/default). Results are discriminated
  // unions — never throws — so they survive Durable Object RPC boundaries.
  async createBranch(
    name: string,
    startOid: string,
  ): Promise<{ ok: true; ref: string; oid: string } | { ok: false; error: string; status: 400 | 404 | 409 }> {
    if (!isValidBranchName(name)) {
      return { ok: false, error: `invalid branch name: ${name}`, status: 400 };
    }
    if (!/^[0-9a-f]{40}$/i.test(startOid)) {
      return { ok: false, error: 'unknown start point', status: 404 };
    }
    if (!(await this.hasCommit(startOid))) {
      return { ok: false, error: 'unknown start point', status: 404 };
    }
    const ref = `refs/heads/${name}`;
    try {
      await git.resolveRef({ fs: this.fs, gitdir: this.gitdir, ref });
      return { ok: false, error: 'branch already exists', status: 409 };
    } catch {
      // Missing — the expected case for creation.
    }
    try {
      await git.branch({ fs: this.fs, gitdir: this.gitdir, ref: name, object: startOid, checkout: false });
    } catch (error) {
      logger.warn(`(create-branch) Failed to create branch ${name}: ${String(error)}`);
      return { ok: false, error: 'failed to create branch', status: 400 };
    }
    return { ok: true, ref, oid: startOid.toLowerCase() };
  }

  async deleteBranchRef(name: string): Promise<{ ok: true; ref: string } | { ok: false; error: string; status: 400 | 404 | 409 }> {
    if (!isValidBranchName(name)) {
      return { ok: false, error: `invalid branch name: ${name}`, status: 400 };
    }
    const ref = branchRefFor(name);
    try {
      await git.resolveRef({ fs: this.fs, gitdir: this.gitdir, ref });
    } catch {
      return { ok: false, error: 'branch not found', status: 404 };
    }
    const current = await this.currentBranch();
    if (current === name) {
      return { ok: false, error: 'cannot delete the default branch', status: 409 };
    }
    try {
      await git.deleteRef({ fs: this.fs, gitdir: this.gitdir, ref });
    } catch (error) {
      logger.warn(`(delete-branch) Failed to delete branch ${name}: ${String(error)}`);
      return { ok: false, error: 'failed to delete branch', status: 400 };
    }
    return { ok: true, ref };
  }

  async setDefaultBranch(name: string): Promise<{ ok: true; defaultBranch: string } | { ok: false; error: string; status: 400 | 404 }> {
    if (!isValidBranchName(name)) {
      return { ok: false, error: `invalid branch name: ${name}`, status: 400 };
    }
    try {
      await git.resolveRef({ fs: this.fs, gitdir: this.gitdir, ref: branchRefFor(name) });
    } catch {
      return { ok: false, error: 'branch not found', status: 404 };
    }
    try {
      await git.writeRef({ fs: this.fs, gitdir: this.gitdir, ref: 'HEAD', value: branchRefFor(name), force: true, symbolic: true });
    } catch (error) {
      logger.warn(`(set-default-branch) Failed to point HEAD at ${name}: ${String(error)}`);
      return { ok: false, error: 'failed to update default branch', status: 400 };
    }
    return { ok: true, defaultBranch: name };
  }

  private async hasCommit(oid: string): Promise<boolean> {
    try {
      const object = await git.readObject({ fs: this.fs, gitdir: this.gitdir, oid });
      return object.type === 'commit';
    } catch {
      return false;
    }
  }

  async listTags(): Promise<Array<{ ref: string; oid: string }>> {
    try {
      const tagRefs = await git.listTags({
        fs: this.fs,
        gitdir: this.gitdir,
      });
      const packed = await this.loadPackedRefsMap();
      const tags = await mapWithConcurrency(tagRefs, MAX_REF_RESOLVE_CONCURRENCY, async (tag) => {
        const ref = `refs/tags/${tag}`;
        const oid = await this.resolveLooseOrPacked(ref, packed);
        return { ref, oid };
      });
      return tags.filter((t) => OID_RE.test(t.oid));
    } catch {
      return [];
    }
  }

  // Single-read packed-refs snapshot per listing. Previously each
  // `resolveRef` re-read `packed-refs` + the loose file (2-3 SQLite rows per
  // ref); now one shared `packed-refs` read plus one loose read per ref.
  private async loadPackedRefsMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const raw = (await this.fs.promises.readFile(`${this.gitdir}/packed-refs`, { encoding: 'utf8' })) as string;
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) continue;
        const [oid, ref] = trimmed.split(' ', 2);
        if (oid && ref && OID_RE.test(oid) && ref.startsWith('refs/')) map.set(ref, oid.toLowerCase());
      }
    } catch {
      // No packed-refs (fresh repo with only loose refs).
    }
    return map;
  }

  private async resolveLooseOrPacked(ref: string, packed: Map<string, string>): Promise<string> {
    try {
      const raw = (await this.fs.promises.readFile(`${this.gitdir}/${ref}`, { encoding: 'utf8' })) as string;
      const oid = raw.trim().split('\n', 1)[0]?.trim() ?? '';
      if (OID_RE.test(oid)) return oid.toLowerCase();
    } catch {
      // Missing loose ref — fall through to packed map.
    }
    const fromPacked = packed.get(ref);
    if (fromPacked) return fromPacked;
    return git.resolveRef({ fs: this.fs, gitdir: this.gitdir, ref });
  }

  async resolveRef(ref = 'HEAD') {
    try {
      const oid = await git.resolveRef({
        fs: this.fs,
        gitdir: this.gitdir,
        ref,
      });
      return oid;
    } catch (error) {
      logger.warn(`(resolve-ref) Failed to resolve ref ${ref}: ${String(error)}`);
      return null;
    }
  }

  async applyRefUpdates(commands: Array<{ oldOid: string; newOid: string; ref: string }>, atomic: boolean): Promise<RefUpdateResult[]> {
    const planner = new RefUpdatePlanner(this.fs, this.gitdir);
    let results: RefUpdateResult[] = [];
    for (const cmd of commands) {
      results.push(await planner.planCommand(cmd));
    }

    if (atomic) {
      results = planner.applyAtomicGate(results);
    }

    for (const [i, cmd] of commands.entries()) {
      if (!results[i].ok) continue;

      const isDelete = classifyRefCommand(cmd) === 'delete';

      try {
        if (isDelete) {
          await git.deleteRef({
            fs: this.fs,
            gitdir: this.gitdir,
            ref: cmd.ref,
          });
        } else {
          await git.writeRef({
            fs: this.fs,
            gitdir: this.gitdir,
            ref: cmd.ref,
            value: cmd.newOid,
            force: true,
          });
        }
      } catch (error) {
        results[i] = {
          ref: cmd.ref,
          ok: false,
          error: `failed to update: ${(error as Error).message}`,
        };
      }
    }

    return results;
  }
}
