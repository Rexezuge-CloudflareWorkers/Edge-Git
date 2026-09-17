import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { BaseScheduledTask } from './IScheduledTask';

const logger = createLogger('CronTasks');

const WEBHOOK_FLUSH_LIMIT = 50;

// Cron sweeper for webhook deliveries: retries pending rows whose
// `next_retry_at` has passed (request-triggered `waitUntil` flushes cover
// the happy path). Per-row optimistic claims make overlapping flushes safe.
class WebhookDeliveryTask extends BaseScheduledTask {
  public readonly name = 'WebhookDeliveryTask';
  public readonly phase: 1 | 2 = 2;

  protected async handleScheduledTask(env: Env): Promise<void> {
    const scope = createRequestScope(env);
    const summary = await scope.get(Tokens.WebhookDeliveryService).processDue({ limit: WEBHOOK_FLUSH_LIMIT });
    if (summary.processed > 0) {
      logger.info(`Flushed ${summary.processed} webhook deliveries (${summary.succeeded} succeeded, ${summary.failed} failed)`);
    }
  }
}

export { WebhookDeliveryTask, WEBHOOK_FLUSH_LIMIT };
