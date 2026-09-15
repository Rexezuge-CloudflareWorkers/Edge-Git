import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';
import type { RefUpdateResult } from '@edge-git/git-protocol';

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
      const headContent = await this.fs.promises.readFile('/repo/HEAD', {
        encoding: 'utf8',
      });
      const headStr = typeof headContent === 'string' ? headContent : new TextDecoder().decode(headContent);
      const match = /^ref:\s*(\S.*)$/.exec(headStr.trim());
      if (match) {
        symbolicHead = match[1];
      }
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
    const results: RefUpdateResult[] = [];
    const ZERO_OID = '0'.repeat(40);

    for (const cmd of commands) {
      const isDelete = cmd.newOid === ZERO_OID;
      const isCreate = cmd.oldOid === ZERO_OID;

      try {
        let currentOid: string | null = null;
        try {
          currentOid = await git.resolveRef({
            fs: this.fs,
            gitdir: '/repo',
            ref: cmd.ref,
          });
        } catch {
          logger.info(`(apply-ref-updates): Ref ${cmd.ref} does not exist.`);
        }

        if (currentOid && cmd.oldOid !== ZERO_OID && currentOid !== cmd.oldOid) {
          results.push({
            ref: cmd.ref,
            ok: false,
            error: 'ref update rejected: old OID mismatch',
          });
          continue;
        }

        if (isDelete) {
          if (currentOid) {
            results.push({ ref: cmd.ref, ok: true });
          } else {
            results.push({
              ref: cmd.ref,
              ok: false,
              error: "ref doesn't exist",
            });
          }
        } else if (isCreate) {
          if (currentOid) {
            results.push({
              ref: cmd.ref,
              ok: false,
              error: 'ref already exists',
            });
          } else {
            results.push({ ref: cmd.ref, ok: true });
          }
        } else {
          if (!currentOid) {
            results.push({
              ref: cmd.ref,
              ok: false,
              error: "ref doesn't exist",
            });
            continue;
          }

          const isFF = await git.isDescendent({
            fs: this.fs,
            gitdir: '/repo',
            oid: cmd.newOid,
            ancestor: currentOid,
          });

          if (isFF) {
            results.push({ ref: cmd.ref, ok: true });
          } else {
            results.push({
              ref: cmd.ref,
              ok: false,
              error: 'non-fast-forward update rejected',
            });
          }
        }
      } catch (error) {
        results.push({
          ref: cmd.ref,
          ok: false,
          error: (error as Error).message,
        });
      }
    }

    if (atomic && results.some((r) => !r.ok)) {
      return results.map((r) => ({
        ...r,
        ok: false,
        error: r.error || 'atomic transaction failed',
      }));
    }

    for (const [i, cmd] of commands.entries()) {
      if (!results[i].ok) continue;

      const isDelete = cmd.newOid === ZERO_OID;

      try {
        if (isDelete) {
          await git.deleteRef({
            fs: this.fs,
            gitdir: '/repo',
            ref: cmd.ref,
          });
        } else {
          await git.writeRef({
            fs: this.fs,
            gitdir: '/repo',
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
