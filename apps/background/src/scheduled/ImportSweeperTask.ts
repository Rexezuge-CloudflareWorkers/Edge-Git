import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { TimestampUtil } from '@edge-git/shared/utils';
import { BaseScheduledTask } from './IScheduledTask';
import { runImportJob } from '../transfer/ImportRunner';

const logger = createLogger('CronTasks');
const IMPORT_SWEEP_LIMIT = 5;

// Cron sweeper for repo imports: claims pending (or stale-running) jobs and
// executes them. Request-triggered `waitUntil` attempts cover the happy
// path; this task retries whatever is left behind.
class ImportSweeperTask extends BaseScheduledTask {
  public readonly name = 'ImportSweeperTask';
  public readonly phase: 1 | 2 = 2;

  protected async handleScheduledTask(env: Env): Promise<void> {
    const scope = createRequestScope(env);
    const svc = scope.get(Tokens.ImportService);
    const limits = svc.transferLimits();
    const importDAO = await scope.get(Tokens.ImportDAO)();
    const repoDAO = await scope.get(Tokens.RepositoryDAO)();
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const due = await importDAO.claimDue(IMPORT_SWEEP_LIMIT, limits.staleSeconds, now).catch(() => []);
    for (const job of due) {
      try {
        const repo = await repoDAO.getById(job.repository_id).catch(() => null);
        if (!repo) {
          await importDAO.markFailed(job.id, 'repository no longer exists', now).catch(() => undefined);
          continue;
        }
        await runImportJob(env, `${repo.owner}/${repo.name}`, job.id);
      } catch (error) {
        logger.error(`Import sweeper: job ${job.id} failed`, error);
      }
    }
    if (due.length > 0) logger.info(`Import sweeper processed ${due.length} jobs`);
  }
}

export { ImportSweeperTask, IMPORT_SWEEP_LIMIT };
