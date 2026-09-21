import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { fetchRemotePack } from '@edge-git/git-protocol';
import { TimestampUtil, repoDoKeyForFullName } from '@edge-git/shared/utils';
import { workerFetchAdapter } from './fetchAdapter';

const logger = createLogger('ImportRunner');

interface RepoStub {
  listRefs(): Promise<{ refs: Array<{ ref: string; oid: string }>; symbolicHead: string | null }>;
  importPack(pack: Uint8Array, refs?: Array<{ ref: string; oid: string }>): Promise<{ importedRefs: string[] }>;
  setDefaultBranch(branch: string): Promise<unknown>;
}

// Execute one import job: refuse non-empty repos, fetch the remote pack
// over Smart HTTP, index it into the repo DO. Never throws — failures are
// recorded on the job row for the status endpoint + cron visibility.
async function runImportJob(env: Env, fullName: string, jobId: string): Promise<void> {
  const scope = createRequestScope(env);
  const importDAO = await scope.get(Tokens.ImportDAO)();
  const job = await importDAO.getById(jobId).catch(() => null);
  if (!job || (job.status !== 'pending' && job.status !== 'running')) return;
  const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
  const fail = async (message: string): Promise<void> => {
    logger.error(`Import ${jobId} for ${fullName} failed: ${message}`);
    await importDAO.markFailed(jobId, message, TimestampUtil.getCurrentUnixTimestampInSeconds()).catch(() => undefined);
  };
  try {
    // Route via the canonical lowercase DO key (see doStubs.getRepoStub):
    // raw-case getByName forks a second isolate that reads never see.
    const stub = env.REPO.getByName(repoDoKeyForFullName(fullName)) as unknown as RepoStub;
    const local = await stub.listRefs().catch(() => null);
    if (local && (local.refs ?? []).length > 0) {
      await fail('repository is not empty; imports only target empty repositories');
      return;
    }
    const limits = scope.get(Tokens.ImportService).transferLimits();
    const { refs, pack, symbolicHead } = await fetchRemotePack(workerFetchAdapter(), job.source_url, {
      maxRefs: limits.maxRefs,
      maxPackBytes: limits.maxPackBytes,
      timeoutMs: limits.timeoutMs,
    });
    const { importedRefs } = await stub.importPack(pack, refs);
    // Preserve the upstream default branch so clones and default reads land
    // on real content when the source lives off `main`. Best-effort.
    if (symbolicHead && symbolicHead.startsWith('refs/heads/') && importedRefs.includes(symbolicHead)) {
      await stub.setDefaultBranch(symbolicHead.slice('refs/heads/'.length)).catch(() => undefined);
    }
    await importDAO.markDone(jobId, JSON.stringify(refs), importedRefs.length, now).catch(() => undefined);
    logger.info(`Import ${jobId} for ${fullName} done: ${importedRefs.length} refs`);
  } catch (error) {
    await fail(error instanceof Error ? error.message : 'import failed');
  }
}

export { runImportJob };
