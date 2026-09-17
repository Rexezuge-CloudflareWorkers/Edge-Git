import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { TimestampUtil } from '@edge-git/shared/utils';
import { BaseScheduledTask } from './IScheduledTask';
import { runMirrorSync } from '../transfer/MirrorRunner';

const logger = createLogger('CronTasks');
const MIRROR_SWEEP_LIMIT = 10;

// Cron driver for scheduled pull-mirrors: runs every mirror whose interval
// has elapsed. Fast-forward only; consecutive failures auto-disable the
// mirror (see MirrorDAO.recordRun).
class MirrorSyncTask extends BaseScheduledTask {
  public readonly name = 'MirrorSyncTask';
  public readonly phase: 1 | 2 = 2;

  protected async handleScheduledTask(env: Env): Promise<void> {
    const scope = createRequestScope(env);
    const mirrorDAO = await scope.get(Tokens.MirrorDAO)();
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const due = await mirrorDAO.listDue(now, MIRROR_SWEEP_LIMIT).catch(() => []);
    for (const mirror of due) {
      try {
        await runMirrorSync(env, mirror.repository_id);
      } catch (error) {
        logger.error(`Mirror sync: repo ${mirror.repository_id} failed`, error);
      }
    }
    if (due.length > 0) logger.info(`Mirror sync processed ${due.length} mirrors`);
  }
}

export { MirrorSyncTask, MIRROR_SWEEP_LIMIT };
