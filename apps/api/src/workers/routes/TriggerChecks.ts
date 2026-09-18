import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { getCheckRunnerStub } from '../checkStub';
import { publishCheckUpdate } from './SocialEmit';

// Shared trigger: match the branch protection rule for `branch`, report a
// queued run per required context on `headSha` (idempotent — re-pushes
// refresh), and enqueue the CheckRunnerWorker DO. Best-effort: never throws,
// so git pushes and PR creation never fail because of CI bookkeeping. The
// cron stale task times out rows missed by a failed enqueue.
async function triggerRequiredChecks(
  env: Env,
  input: { repositoryId: string; fullName: string; branch: string; headSha: string; actorEmail: string },
): Promise<{ triggered: string[] }> {
  try {
    if (!/^[0-9a-f]{40}$/i.test(input.headSha) || /^0{40}$/.test(input.headSha)) return { triggered: [] };
    const scope = createRequestScope(env);
    const rule = await scope.get(Tokens.BranchProtectionService).matchForRepo(input.repositoryId, input.branch).catch(() => null);
    const required = rule?.requireStatusChecks ?? [];
    if (required.length === 0) return { triggered: [] };
    const checks = scope.get(Tokens.CheckService);
    const triggered: string[] = [];
    for (const context of required) {
      try {
        await checks.reportStatus({
          repositoryId: input.repositoryId,
          headSha: input.headSha,
          context,
          creatorEmail: input.actorEmail,
        });
        triggered.push(context);
      } catch {
        // Conflict (already completed) or limit — skip, never fail the push.
        triggered.push(context);
      }
    }
    try {
      const stub = getCheckRunnerStub(env, input.fullName);
      void stub
        .enqueueChecks({
          repositoryId: input.repositoryId,
          headSha: input.headSha.toLowerCase(),
          contexts: required,
          actorEmail: input.actorEmail,
        })
        .catch(() => undefined);
    } catch {
      // DO unavailable — cron sweeper still expires rows.
    }
    if (triggered.length > 0) {
      await publishCheckUpdate(env, {
        fullName: input.fullName,
        headSha: input.headSha,
        context: triggered.join(','),
        status: 'queued',
        actorEmail: input.actorEmail,
        title: `Queued ${triggered.length} Required Check${triggered.length === 1 ? '' : 's'}`,
      }).catch(() => undefined);
    }
    return { triggered };
  } catch {
    return { triggered: [] };
  }
}

export { triggerRequiredChecks };
