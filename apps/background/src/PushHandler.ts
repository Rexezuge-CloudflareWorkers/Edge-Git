import type { GitService, IsoGitFs } from '@edge-git/git-service';
import {
  branchNameFromRef,
  buildReportStatus,
  checkStaticPushProtection,
  isZeroOid,
  parseReceivePackRequest,
  validateReceivePackCommands,
  validateReceivePackCounts,
} from '@edge-git/git-protocol';
import type { ProtectedRefRule } from '@edge-git/git-protocol';
import { createLogger } from '@edge-git/backend-runtime/logger';

const logger = createLogger('PushHandler');

interface PushLimits {
  maxCommands: number;
  maxPackBytes: number;
}

interface PushHandlerDeps {
  isoGitFs: ReturnType<IsoGitFs['getPromiseFsClient']>;
  git: GitService;
  getFullName: () => string | undefined;
}

// Handles `git-receive-pack` (push): unpack validation, pack indexing,
// and atomic/non-atomic ref updates.
//
// Branch protection (`protections`, resolved by the API from D1 and passed
// in because the DO cannot read D1):
// - deletion / direct-push (`require_pr`) gates are pure and evaluated first;
// - force-push detection needs ancestry (`isAncestor`) after the pack is
//   indexed (the new objects must exist locally first).
// - any violation rejects the whole push, pre-receive-hook style: every ref
//   reports `ng` (`unpack ok`), blocked refs keep their reason and the rest
//   report a generic decline. Nothing is applied, so atomicity is preserved
//   regardless of the client's `atomic` capability.
class PushHandler {
  constructor(private readonly deps: PushHandlerDeps) {}

  public async receivePack(data: Uint8Array, limits: PushLimits, protections: ProtectedRefRule[] = []): Promise<Response> {
    const { isoGitFs, git, getFullName } = this.deps;
    const { commands, packfile, capabilities } = parseReceivePackRequest(data);

    if (commands.length === 0) {
      return buildReportStatus([{ ref: '*', ok: false, error: 'no commands' }], false);
    }

    const limitError = validateReceivePackCounts(commands.length, packfile.byteLength, {
      maxCommands: limits.maxCommands,
      maxPackBytes: limits.maxPackBytes,
    });
    if (limitError) {
      logger.error(`(receive-pack) Rejected ${getFullName() ?? 'unknown repo'}: ${limitError}`);
      return buildReportStatus([{ ref: '*', ok: false, error: limitError }], false);
    }

    const commandError = validateReceivePackCommands(commands);
    if (commandError) {
      logger.error(`(receive-pack) Rejected ${getFullName() ?? 'unknown repo'}: ${commandError}`);
      return buildReportStatus([{ ref: '*', ok: false, error: commandError }], false);
    }

    if (capabilities.includes('push-options')) {
      logger.info(`(receive-pack) Ignoring push-options for ${getFullName() ?? 'unknown repo'}: no hooks to consume them`);
    }

    const byRef = new Map(protections.map((p) => [p.ref, p]));
    const blocked = new Map<string, string>();
    for (const cmd of commands) {
      const staticError = checkStaticPushProtection(cmd, byRef.get(cmd.ref));
      if (staticError) blocked.set(cmd.ref, staticError);
    }

    if (blocked.size > 0) {
      // Fail closed, pre-receive-hook style: reject every ref so the client
      // retries as a whole. Blocked refs keep their reason. Nothing is
      // written or applied.
      logger.error(`(receive-pack) Rejected ${getFullName() ?? 'unknown repo'}: protected branch update declined`);
      const results = commands.map((cmd) => ({
        ref: cmd.ref,
        ok: false as const,
        error: blocked.get(cmd.ref) ?? 'push rejected: protected branch update declined',
      }));
      return buildReportStatus(results, true);
    }

    const packFilePath = `/repo/objects/pack/pack-${Date.now()}.pack`;
    let wrotePack = false;
    try {
      await isoGitFs.promises.writeFile(packFilePath, packfile);
      wrotePack = true;
      await git.indexPack(packFilePath.replace('/repo/', ''));
    } catch (error) {
      logger.error('(receive-pack) Failed to index packfile: ', error);
      if (wrotePack) {
        await isoGitFs.promises.unlink(packFilePath).catch(() => undefined);
      }
      return buildReportStatus(
        [
          {
            ref: '*',
            ok: false,
            error: `unpack failed: ${(error as Error).message}`,
          },
        ],
        false,
      );
    }

    // Force-push detection runs after indexing so ancestry covers the new objects.
    const forceBlocked = new Map<string, string>();
    for (const cmd of commands) {
      const rule = byRef.get(cmd.ref);
      if (!rule?.blockForcePush) continue;
      if (!branchNameFromRef(cmd.ref)) continue;
      if (isZeroOid(cmd.oldOid) || isZeroOid(cmd.newOid)) continue;
      if (cmd.oldOid === cmd.newOid) continue;
      let fastForward = false;
      try {
        fastForward = await git.isAncestor(cmd.oldOid, cmd.newOid);
      } catch {
        fastForward = false;
      }
      if (!fastForward) {
        const branch = branchNameFromRef(cmd.ref) ?? cmd.ref;
        forceBlocked.set(cmd.ref, `non-fast-forward push to protected branch "${branch}" is blocked`);
      }
    }
    if (forceBlocked.size > 0) {
      logger.error(`(receive-pack) Rejected ${getFullName() ?? 'unknown repo'}: protected branch update declined`);
      const results = commands.map((cmd) => ({
        ref: cmd.ref,
        ok: false as const,
        error: forceBlocked.get(cmd.ref) ?? 'push rejected: protected branch update declined',
      }));
      return buildReportStatus(results, true);
    }

    const results = await git.applyRefUpdates(commands, capabilities.includes('atomic'));
    git.clearCache();

    return buildReportStatus(results, true);
  }
}

export { PushHandler };
export type { PushLimits, PushHandlerDeps };
