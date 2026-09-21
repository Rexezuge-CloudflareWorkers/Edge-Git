import { TimestampUtil } from '@edge-git/shared/utils';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { BaseScheduledTask } from './IScheduledTask';

const logger = createLogger('CronTasks');

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
    const deployPruned = await scope
      .get(Tokens.DeployKeyDAO)()
      .then((dao) =>
        typeof (dao as unknown as { pruneExpired?: (now: number, limit: number) => Promise<number> }).pruneExpired === 'function'
          ? (dao as unknown as { pruneExpired: (now: number, limit: number) => Promise<number> }).pruneExpired(
              TimestampUtil.getCurrentUnixTimestampInSeconds(),
              500,
            )
          : 0,
      )
      .catch(() => 0);
    if (deployPruned > 0) logger.info(`Pruned ${deployPruned} expired deploy keys`);
  }
}

export { BackgroundTaskRunPruningTask, SocialPruningTask };
