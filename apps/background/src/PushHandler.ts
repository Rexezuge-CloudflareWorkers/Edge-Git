import type { GitService, IsoGitFs } from '@edge-git/git-service';
import { buildReportStatus, parseReceivePackRequest, validateReceivePackCommands, validateReceivePackCounts } from '@edge-git/git-protocol';
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
class PushHandler {
  constructor(private readonly deps: PushHandlerDeps) {}

  public async receivePack(data: Uint8Array, limits: PushLimits): Promise<Response> {
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

    const atomic = capabilities.includes('atomic');
    const results = await git.applyRefUpdates(commands, atomic);
    git.clearCache();

    return buildReportStatus(results, true);
  }
}

export { PushHandler };
export type { PushLimits, PushHandlerDeps };
