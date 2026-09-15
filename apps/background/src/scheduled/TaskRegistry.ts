import { TimestampUtil } from '@edge-git/shared/utils';
import { UserAccessTokenDAO } from '@edge-git/backend-data/dao';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';

const logger = createLogger('CronTasks');

export interface ScheduledTask {
  name: string;
  phase: 1 | 2;
  run: (env: Env) => Promise<void>;
}

async function pruneExpiredTokens(env: Env): Promise<void> {
  const dao = new UserAccessTokenDAO(env.DB);
  const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
  const pruned = await dao.pruneExpired(now, 500);
  if (pruned > 0) {
    logger.info(`Pruned ${pruned} expired access tokens`);
  }
}

const CRON_TASK_DEFINITIONS: ScheduledTask[] = [
  {
    name: 'ExpiredTokenPruningTask',
    phase: 1,
    run: pruneExpiredTokens,
  },
  {
    name: 'BackgroundTaskRunPruningTask',
    phase: 2,
    run: async (env: Env) => {
      const retention = ConfigurationManager.processing.getTaskRunRetentionDays(env);
      logger.info(`Background task retention ${retention}d (no-op v1)`);
    },
  },
];

async function runScheduledTasks(env: Env, cron: string, scheduledTime: number): Promise<void> {
  logger.info(`Running scheduled tasks for ${cron} at ${scheduledTime}`);
  const phase1 = CRON_TASK_DEFINITIONS.filter((t) => t.phase === 1);
  const phase2 = CRON_TASK_DEFINITIONS.filter((t) => t.phase === 2);
  await Promise.all(phase1.map((t) => t.run(env).catch((error: unknown) => logger.error(`Task ${t.name} failed`, error))));
  await Promise.all(phase2.map((t) => t.run(env).catch((error: unknown) => logger.error(`Task ${t.name} failed`, error))));
}

export { CRON_TASK_DEFINITIONS, runScheduledTasks };
