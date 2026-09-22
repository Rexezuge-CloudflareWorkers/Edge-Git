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
      const branches = await Promise.all(
        branchRefs.map(async (branch) => {
          const oid = await git.resolveRef({
            fs: this.fs,
            gitdir: this.gitdir,
            ref: `refs/heads/${branch}`,
          });
          return { ref: `refs/heads/${branch}`, oid };
        }),
      );
      return branches;
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
      const tags = await Promise.all(
        tagRefs.map(async (tag) => {
          const oid = await git.resolveRef({
            fs: this.fs,
            gitdir: this.gitdir,
            ref: `refs/tags/${tag}`,
          });
          return { ref: `refs/tags/${tag}`, oid };
        }),
      );
      return tags;
    } catch {
      return [];
    }
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
