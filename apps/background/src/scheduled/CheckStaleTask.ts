import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { BaseScheduledTask } from './IScheduledTask';

const logger = createLogger('CronTasks');

const CHECK_STALE_LIMIT = 100;

// Times out `queued`/`in_progress` check runs past CHECK_TIMEOUT_SECONDS
// (default 3600) so a lost DO alarm or dead external runner cannot block a
// protected merge forever. `timed_out` counts as failing in the merge gate.
class CheckStaleTask extends BaseScheduledTask {
  public readonly name = 'CheckStaleTask';
  public readonly phase: 1 | 2 = 2;

  protected async handleScheduledTask(env: Env): Promise<void> {
    const marked = await createRequestScope(env)
      .get(Tokens.CheckService)
      .markStale(undefined, CHECK_STALE_LIMIT)
      .catch(() => 0);
    if (marked > 0) {
      logger.info(`Timed out ${marked} stale check runs`);
    }
  }
}

export { CheckStaleTask, CHECK_STALE_LIMIT };
