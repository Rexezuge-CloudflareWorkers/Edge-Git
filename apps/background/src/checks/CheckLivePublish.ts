import { createLogger } from '@edge-git/backend-runtime/logger';
import { isChannel, repoShardFor } from '@edge-git/shared/realtime';

const logger = createLogger('CheckLivePublish');

interface CheckLiveItem {
  headSha: string;
  actorEmail: string;
}

interface CheckLiveRun {
  runId: string;
  context: string;
  conclusion: string;
  title: string;
}

// Live `PullChecks` badge: one RPC to the repo shard on the per-SHA channel.
// Best-effort — completions are already durable in D1, so this never throws.
async function publishCheckLive(env: Env, fullName: string, item: CheckLiveItem, run: CheckLiveRun): Promise<void> {
  try {
    const channel = `checks:${item.headSha.toLowerCase()}`;
    if (!isChannel(channel)) return;
    const ns = (env as unknown as { REALTIME?: DurableObjectNamespace }).REALTIME;
    if (!ns) return;
    const stub = ns.getByName(repoShardFor(fullName)) as unknown as {
      publish(input: Record<string, unknown>): Promise<unknown>;
    };
    await stub
      .publish({
        channel,
        type: 'check_run.updated',
        actor: item.actorEmail,
        title: run.title || `${run.context}: ${run.conclusion}`,
        sha: item.headSha.toLowerCase(),
        extra: { check_run_id: run.runId, context: run.context, status: 'completed', conclusion: run.conclusion },
      })
      .catch(() => undefined);
  } catch (error) {
    logger.error('CheckLivePublish: publish failed', error);
  }
}

export { publishCheckLive };
export type { CheckLiveItem, CheckLiveRun };
