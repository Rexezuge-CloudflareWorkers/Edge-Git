import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';
import type { RefUpdateResult } from '@edge-git/git-protocol';
import { classifyRefCommand, ZERO_OID } from './RefValidation';

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

interface RefUpdateCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

const logger = {
  info: (...args: unknown[]): void => console.info('[INFO] [GitService]', ...args),
};

/**
 * Ref-update validation phase extracted from `RefService.applyRefUpdates`
 * (SRP). Plans each command — existence, old-OID match, create/delete
 * preconditions, fast-forward check — without mutating refs, so the plan
 * is inspectable and `RefService` keeps only the atomic gate + write loop.
 */
class RefUpdatePlanner {
  constructor(
    private readonly fs: PromiseFsClient,
    private readonly gitdir: string,
  ) {}

  async planCommand(cmd: RefUpdateCommand): Promise<RefUpdateResult> {
    const kind = classifyRefCommand(cmd);
    const isDelete = kind === 'delete';
    const isCreate = kind === 'create';

    try {
      let currentOid: string | null = null;
      try {
        currentOid = await git.resolveRef({
          fs: this.fs,
          gitdir: this.gitdir,
          ref: cmd.ref,
        });
      } catch {
        logger.info(`(apply-ref-updates): Ref ${cmd.ref} does not exist.`);
      }

      if (currentOid && cmd.oldOid !== ZERO_OID && currentOid !== cmd.oldOid) {
        return { ref: cmd.ref, ok: false, error: 'ref update rejected: old OID mismatch' };
      }

      if (isDelete) {
        if (currentOid) {
          return { ref: cmd.ref, ok: true };
        }
        return { ref: cmd.ref, ok: false, error: "ref doesn't exist" };
      }
      if (isCreate) {
        if (currentOid) {
          return { ref: cmd.ref, ok: false, error: 'ref already exists' };
        }
        return { ref: cmd.ref, ok: true };
      }
      if (!currentOid) {
        return { ref: cmd.ref, ok: false, error: "ref doesn't exist" };
      }

      const isFF = await git.isDescendent({
        fs: this.fs,
        gitdir: this.gitdir,
        oid: cmd.newOid,
        ancestor: currentOid,
      });

      if (isFF) {
        return { ref: cmd.ref, ok: true };
      }
      return { ref: cmd.ref, ok: false, error: 'non-fast-forward update rejected' };
    } catch (error) {
      return { ref: cmd.ref, ok: false, error: (error as Error).message };
    }
  }

  /**
   * Atomic gate: when any plan entry failed, every entry fails so callers
   * never partially apply (matches the previous inline behavior).
   */
  applyAtomicGate(results: RefUpdateResult[]): RefUpdateResult[] {
    if (results.some((r) => !r.ok)) {
      return results.map((r) => ({ ...r, ok: false, error: r.error || 'atomic transaction failed' }));
    }
    return results;
  }
}

export { RefUpdatePlanner };
export type { RefUpdateCommand };
