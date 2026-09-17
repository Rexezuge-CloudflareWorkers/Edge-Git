import { TimestampUtil } from '@edge-git/shared/utils';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { BaseScheduledTask } from './IScheduledTask';
import type { ScheduledTask } from './IScheduledTask';
import { AuditLogCleanupTask } from './AuditLogCleanupTask';
import { SearchBackfillTask } from './SearchBackfillTask';
import { WebhookDeliveryTask } from './WebhookDeliveryTask';

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
    const prunedEvents = await scope.get(Tokens.EventDAO)().then((dao) => dao.pruneOlderThan(cutoff, 500)).catch(() => 0);
    const prunedNotifications = await scope.get(Tokens.NotificationDAO)().then((dao) => dao.pruneReadOlderThan(cutoff, 500)).catch(() => 0);
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
  new WebhookDeliveryTask(),
];

async function runScheduledTasks(env: Env, cron: string, scheduledTime: number): Promise<void> {
  logger.info(`Running scheduled tasks for ${cron} at ${scheduledTime}`);
  const phase1 = CRON_TASK_DEFINITIONS.filter((t) => t.phase === 1);
  const phase2 = CRON_TASK_DEFINITIONS.filter((t) => t.phase === 2);
  await Promise.all(phase1.map((t) => t.run(env).catch((error: unknown) => logger.error(`Task ${t.name} failed`, error))));
  await Promise.all(phase2.map((t) => t.run(env).catch((error: unknown) => logger.error(`Task ${t.name} failed`, error))));
}

export { CRON_TASK_DEFINITIONS, runScheduledTasks, ExpiredTokenPruningTask, BackgroundTaskRunPruningTask, SocialPruningTask };
export { AuditLogCleanupTask } from './AuditLogCleanupTask';
export { SearchBackfillTask } from './SearchBackfillTask';
export { WebhookDeliveryTask } from './WebhookDeliveryTask';
export type { ScheduledTask } from './IScheduledTask';
