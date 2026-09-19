import { TimestampUtil } from '@edge-git/shared/utils';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { BaseScheduledTask } from './IScheduledTask';
import type { ScheduledTask } from './IScheduledTask';
import { AuditLogCleanupTask } from './AuditLogCleanupTask';
import { CheckPruneTask } from './CheckPruneTask';
import { CheckStaleTask } from './CheckStaleTask';
import { SearchBackfillTask } from './SearchBackfillTask';
import { WebhookDeliveryTask } from './WebhookDeliveryTask';
import { ImportSweeperTask } from './ImportSweeperTask';
import { MirrorSyncTask } from './MirrorSyncTask';

const logger = createLogger('CronTasks');

class ExpiredTokenPruningTask extends BaseScheduledTask {
  public readonly name = 'ExpiredTokenPruningTask';
  public readonly phase: 1 | 2 = 1;

  protected async handleScheduledTask(env: Env): Promise<void> {
    const dao = await createRequestScope(env).get(Tokens.UserAccessTokenDAO)();
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const pruned = await dao.pruneExpired(now, 500);
    if (pruned > 0) {
      logger.info(`Pruned ${pruned} expired access tokens`);
    }
  }
}

class BackgroundTaskRunPruningTask extends BaseScheduledTask {
  public readonly name = 'BackgroundTaskRunPruningTask';
  public readonly phase: 1 | 2 = 2;

  protected handleScheduledTask(env: Env): Promise<void> {
    const retention = ConfigurationManager.processing.getTaskRunRetentionDays(env);
    logger.info(`Background task retention ${retention}d (no-op v1)`);
    return Promise.resolve();
  }
}

class SocialPruningTask extends BaseScheduledTask {
  public readonly name = 'SocialPruningTask';
  public readonly phase: 1 | 2 = 2;

  protected async handleScheduledTask(env: Env): Promise<void> {
    const retentionDays = ConfigurationManager.processing.getAuditLogRetentionDays(env);
    const cutoff = TimestampUtil.getCurrentUnixTimestampInSeconds() - retentionDays * 86_400;
    const scope = createRequestScope(env);
    const prunedEvents = await scope
      .get(Tokens.EventDAO)()
      .then((dao) => dao.pruneOlderThan(cutoff, 500))
      .catch(() => 0);
    const prunedNotifications = await scope
      .get(Tokens.NotificationDAO)()
      .then((dao) => dao.pruneReadOlderThan(cutoff, 500))
      .catch(() => 0);
    if (prunedEvents > 0 || prunedNotifications > 0) {
      logger.info(`Pruned ${prunedEvents} repo events and ${prunedNotifications} read notifications`);
    }
    const webhookRetentionDays = ConfigurationManager.webhooks.getDeliveryRetentionDays(env);
    const webhookCutoff = TimestampUtil.getCurrentUnixTimestampInSeconds() - webhookRetentionDays * 86_400;
    const prunedDeliveries = await scope
      .get(Tokens.WebhookDeliveryService)
      .pruneOlderThan(webhookCutoff, 500)
      .catch(() => 0);
    if (prunedDeliveries > 0) {
      logger.info(`Pruned ${prunedDeliveries} webhook deliveries`);
    }
  }
}

const CRON_TASK_DEFINITIONS: ScheduledTask[] = [
  new ExpiredTokenPruningTask(),
  new BackgroundTaskRunPruningTask(),
  new SearchBackfillTask(),
  new SocialPruningTask(),
  new AuditLogCleanupTask(),
  new CheckStaleTask(),
  new CheckPruneTask(),
  new WebhookDeliveryTask(),
  new ImportSweeperTask(),
  new MirrorSyncTask(),
];

// The 4-hour code-search tick. Must match the second entry of
// `triggers.crons` in `apps/api/wrangler.template.jsonc`; fast tasks run on
// every tick, SearchBackfillTask only here. Keep the two in sync when the
// schedule changes.
const SEARCH_TICK_CRON = '7 */4 * * *';

function isSearchTick(cron: string): boolean {
  const normalized = (cron ?? '').trim();
  // Manual POST /run and unit tests pass no cron — run everything so a
  // manual trigger never silently skips work.
  if (!normalized) return true;
  return normalized === SEARCH_TICK_CRON;
}

async function runScheduledTasks(env: Env, cron: string, scheduledTime: number): Promise<void> {
  logger.info(`Running scheduled tasks for ${cron} at ${scheduledTime}`);
  const searchTick = isSearchTick(cron);
  if (!searchTick) logger.info('Skipping SearchBackfillTask (off search tick)');
  const phase1 = CRON_TASK_DEFINITIONS.filter((t) => t.phase === 1);
  const phase2 = CRON_TASK_DEFINITIONS.filter((t) => t.phase === 2 && (searchTick || t.name !== 'SearchBackfillTask'));
  await Promise.all(phase1.map((t) => t.run(env).catch((error: unknown) => logger.error(`Task ${t.name} failed`, error))));
  await Promise.all(phase2.map((t) => t.run(env).catch((error: unknown) => logger.error(`Task ${t.name} failed`, error))));
}

export { CRON_TASK_DEFINITIONS, runScheduledTasks, isSearchTick, SEARCH_TICK_CRON, ExpiredTokenPruningTask, BackgroundTaskRunPruningTask, SocialPruningTask };
export { AuditLogCleanupTask } from './AuditLogCleanupTask';
export { CheckPruneTask } from './CheckPruneTask';
export { CheckStaleTask } from './CheckStaleTask';
export { SearchBackfillTask } from './SearchBackfillTask';
export { WebhookDeliveryTask } from './WebhookDeliveryTask';
export { ImportSweeperTask } from './ImportSweeperTask';
export { MirrorSyncTask } from './MirrorSyncTask';
export type { ScheduledTask } from './IScheduledTask';
