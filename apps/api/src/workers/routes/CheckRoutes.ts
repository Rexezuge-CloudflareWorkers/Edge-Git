import type { Hono } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import { getCheckRunnerStub } from '../doStubs';
import { emitWebhookEvent, publishCheckUpdate } from './SocialEmit';
import { jsonError, requireVisibleRepo, toSafeErrorMessage, toServiceStatus, withPublicRepo, getScope } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';
import { presentMany, presentSingle } from './IdentityPresenter';

type CheckApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function toCheckJson(run: {
  id: string;
  headSha: string;
  context: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  outputTitle: string | null;
  outputSummary: string | null;
  creatorEmail: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}): unknown {
  return {
    id: run.id,
    headSha: run.headSha,
    context: run.context,
    status: run.status,
    conclusion: run.conclusion,
    detailsUrl: run.detailsUrl,
    outputTitle: run.outputTitle,
    outputSummary: run.outputSummary,
    creatorEmail: run.creatorEmail,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

// Best-effort DO enqueue: one RPC per call batches all contexts for the push.
// Never throws — D1 rows are the source of truth; the DO alarm + cron sweeper
// cover missed enqueues.
function enqueueChecksBestEffort(
  env: Env,
  fullName: string,
  input: { repositoryId: string; headSha: string; contexts: string[]; actorEmail: string },
): void {
  try {
    const stub = getCheckRunnerStub(env, fullName);
    void stub.enqueueChecks(input).catch(() => undefined);
  } catch {
    // DO unavailable (tests/legacy env) — cron stale task still times out rows.
  }
}

function registerCheckPublicRoutes(app: CheckApp): void {
  app.get('/repos/:owner/:repo/commits/:sha/checks', async (c) => {
    return withPublicRepo(c, async (row) => {
      try {
        const scope = getScope(c);
        const { runs, state } = await scope.get(Tokens.CheckService).listForSha(row.id, c.req.param('sha'));
        return c.json({ state, checks: await presentMany(scope, runs.map(toCheckJson)) });
      } catch (error) {
        return jsonError(c, toSafeErrorMessage(error, 'Failed to list checks'), toServiceStatus(error));
      }
    });
  });
}

function registerCheckUserRoutes(app: CheckApp): void {
  app.get('/user/repos/:owner/:repo/commits/:sha/checks', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      const scope = getScope(c);
      const { runs, state } = await scope.get(Tokens.CheckService).listForSha(row.id, c.req.param('sha'));
      return c.json({ state, checks: await presentMany(scope, runs.map(toCheckJson)) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to list checks'), toServiceStatus(error));
    }
  });

  // Report a check run (external runners + DO). `write+` only. Re-reporting
  // the same (sha, context) while queued refreshes instead of 409ing.
  app.post('/user/repos/:owner/:repo/checks', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      await getScope(c).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return jsonError(c, 'Forbidden', 403);
    }
    const { malformed, body } = await readJsonBody<{
      headSha?: unknown;
      context?: unknown;
      detailsUrl?: unknown;
      outputTitle?: unknown;
      outputSummary?: unknown;
    }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
      const run = await scope.get(Tokens.CheckService).reportStatus({
        repositoryId: row.id,
        headSha: body.headSha,
        context: body.context,
        creatorEmail: email,
        detailsUrl: body.detailsUrl,
        outputTitle: body.outputTitle,
        outputSummary: body.outputSummary,
      });
      const fullName = `${row.owner}/${row.name}`;
      enqueueChecksBestEffort(c.env, fullName, {
        repositoryId: row.id,
        headSha: run.headSha,
        contexts: [run.context],
        actorEmail: email,
      });
      await emitWebhookEvent(c.env, {
        repositoryId: row.id,
        fullName,
        actorEmail: email,
        event: 'check_run',
        subjectOid: run.headSha,
        title: `${run.context}: ${run.status}`,
        action: 'created',
        extra: { check_run_id: run.id, context: run.context, status: run.status },
      });
      await publishCheckUpdate(c.env, {
        fullName,
        headSha: run.headSha,
        context: run.context,
        status: run.status,
        actorEmail: email,
        checkId: run.id,
      });
      return c.json({ check: await presentSingle(scope, toCheckJson(run)) }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to report check';
      const status = message.includes('already completed') ? 409 : toServiceStatus(error);
      return jsonError(c, toSafeErrorMessage(error, 'Failed to report check'), status as 400 | 403 | 404 | 500);
    }
  });

  // Runner update: transitions queued → in_progress → completed + conclusion.
  app.patch('/user/repos/:owner/:repo/checks/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      await getScope(c).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return jsonError(c, 'Forbidden', 403);
    }
    const { malformed, body } = await readJsonBody<{
      status?: unknown;
      conclusion?: unknown;
      detailsUrl?: unknown;
      outputTitle?: unknown;
      outputSummary?: unknown;
    }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.status !== 'string') return jsonError(c, 'status is required', 400);
    try {
      const scope = getScope(c);
      const run = await scope
        .get(Tokens.CheckService)
        .updateRun({
          repositoryId: row.id,
          id: c.req.param('id'),
          status: body.status as 'queued' | 'in_progress' | 'completed',
          conclusion: body.conclusion,
          detailsUrl: body.detailsUrl,
          outputTitle: body.outputTitle,
          outputSummary: body.outputSummary,
        });
      if (run.status === 'completed') {
        const fullName = `${row.owner}/${row.name}`;
        await emitWebhookEvent(c.env, {
          repositoryId: row.id,
          fullName,
          actorEmail: email,
          event: 'check_run',
          subjectOid: run.headSha,
          title: `${run.context}: ${run.conclusion ?? run.status}`,
          action: 'completed',
          extra: { check_run_id: run.id, context: run.context, status: run.status, conclusion: run.conclusion },
        });
      }
      await publishCheckUpdate(c.env, {
        fullName: `${row.owner}/${row.name}`,
        headSha: run.headSha,
        context: run.context,
        status: run.status,
        conclusion: run.conclusion,
        actorEmail: email,
        checkId: run.id,
      });
      return c.json({ check: await presentSingle(scope, toCheckJson(run)) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update check'), toServiceStatus(error));
    }
  });
}

export { registerCheckPublicRoutes, registerCheckUserRoutes, enqueueChecksBestEffort };
export type { CheckApp };
