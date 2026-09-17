import { TimestampUtil } from '@edge-git/shared/utils';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { BaseScheduledTask } from './IScheduledTask';

const logger = createLogger('CronTasks');

// Prunes `audit_logs` past AUDIT_LOG_RETENTION_DAYS (default 90) — the same
// knob SocialPruningTask already uses for repo_events/notifications, now
// with a real audit consumer (AccessBridge AuditLogCleanupTask pattern).
class AuditLogCleanupTask extends BaseScheduledTask {
  public readonly name = 'AuditLogCleanupTask';
  public readonly phase: 1 | 2 = 2;

  protected async handleScheduledTask(env: Env): Promise<void> {
    const retentionDays = ConfigurationManager.processing.getAuditLogRetentionDays(env);
    const cutoff = TimestampUtil.getCurrentUnixTimestampInSeconds() - retentionDays * 86_400;
    const pruned = await createRequestScope(env)
      .get(Tokens.AuditService)
      .pruneOlderThan(cutoff, 500)
      .catch(() => 0);
    if (pruned > 0) {
      logger.info(`Pruned ${pruned} audit logs`);
    }
  }
}

export { AuditLogCleanupTask };
