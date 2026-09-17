import { TimestampUtil } from '@edge-git/shared/utils';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { BaseScheduledTask } from './IScheduledTask';

const logger = createLogger('CronTasks');

const CHECK_PRUNE_LIMIT = 500;

// Prunes `check_runs` past CHECK_RETENTION_DAYS (default 90) — same scale as
// the audit/social retention knobs.
class CheckPruneTask extends BaseScheduledTask {
  public readonly name = 'CheckPruneTask';
  public readonly phase: 1 | 2 = 2;

  protected async handleScheduledTask(env: Env): Promise<void> {
    const retentionDays = ConfigurationManager.checks.getRetentionDays(env);
    const cutoff = TimestampUtil.getCurrentUnixTimestampInSeconds() - retentionDays * 86_400;
    const pruned = await createRequestScope(env)
      .get(Tokens.CheckService)
      .pruneOlderThan(cutoff, CHECK_PRUNE_LIMIT)
      .catch(() => 0);
    if (pruned > 0) {
      logger.info(`Pruned ${pruned} check runs`);
    }
  }
}

export { CheckPruneTask, CHECK_PRUNE_LIMIT };
