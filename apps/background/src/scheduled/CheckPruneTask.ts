import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { AbstractPruningTask } from './IScheduledTask';

const CHECK_PRUNE_LIMIT = 500;

// Prunes `check_runs` past CHECK_RETENTION_DAYS (default 90) — same scale as
// the audit/social retention knobs.
class CheckPruneTask extends AbstractPruningTask {
  public readonly name = 'CheckPruneTask';
  public readonly phase: 1 | 2 = 2;

  protected getRetentionDays(env: Env): number {
    return ConfigurationManager.checks.getRetentionDays(env);
  }

  protected pruneBatch(env: Env, cutoff: number, batchSize: number): Promise<number> {
    return createRequestScope(env).get(Tokens.CheckService).pruneOlderThan(cutoff, batchSize);
  }

  protected getPrunedNoun(): string {
    return 'check runs';
  }

  protected override getBatchSize(): number {
    return CHECK_PRUNE_LIMIT;
  }
}

export { CheckPruneTask, CHECK_PRUNE_LIMIT };
