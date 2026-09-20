import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { AbstractPruningTask } from './IScheduledTask';

// Prunes `audit_logs` past AUDIT_LOG_RETENTION_DAYS (default 90) — the same
// knob SocialPruningTask already uses for repo_events/notifications, now
// with a real audit consumer (AccessBridge AuditLogCleanupTask pattern).
class AuditLogCleanupTask extends AbstractPruningTask {
  public readonly name = 'AuditLogCleanupTask';
  public readonly phase: 1 | 2 = 2;

  protected getRetentionDays(env: Env): number {
    return ConfigurationManager.processing.getAuditLogRetentionDays(env);
  }

  protected pruneBatch(env: Env, cutoff: number, batchSize: number): Promise<number> {
    return createRequestScope(env).get(Tokens.AuditService).pruneOlderThan(cutoff, batchSize);
  }

  protected getPrunedNoun(): string {
    return 'audit logs';
  }
}

export { AuditLogCleanupTask };
