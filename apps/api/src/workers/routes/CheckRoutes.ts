import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { getCheckRunnerStub } from '../checkStub';
import { emitWebhookEvent } from './SocialEmit';
import { requireVisibleRepo, toServiceStatus, withPublicRepo } from './PublicViewerResolver';

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
    return withPublicRepo(c as never, async (row) => {
      try {
        const { runs, state } = await createRequestScope(c.env)
          .get(Tokens.CheckService)
          .listForSha(row.id, c.req.param('sha'));
        return c.json({ state, checks: runs.map(toCheckJson) });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Failed to list checks' }, toServiceStatus(error));
      }
    });
  });
}

function registerCheckUserRoutes(app: CheckApp): void {
  app.get('/user/repos/:owner/:repo/commits/:sha/checks', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      const { runs, state } = await createRequestScope(c.env).get(Tokens.CheckService).listForSha(row.id, c.req.param('sha'));
      return c.json({ state, checks: runs.map(toCheckJson) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to list checks' }, toServiceStatus(error));
    }
  });

  // Report a check run (external runners + DO). `write+` only. Re-reporting
  // the same (sha, context) while queued refreshes instead of 409ing.
  app.post('/user/repos/:owner/:repo/checks', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      headSha?: unknown;
      context?: unknown;
      detailsUrl?: unknown;
      outputTitle?: unknown;
      outputSummary?: unknown;
    };
    try {
      const run = await createRequestScope(c.env)
        .get(Tokens.CheckService)
        .reportStatus({
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
      return c.json({ check: toCheckJson(run) }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to report check';
      const status = message.includes('already completed') ? 409 : toServiceStatus(error);
      return c.json({ error: message }, status as 400 | 403 | 404 | 500);
    }
  });

  // Runner update: transitions queued → in_progress → completed + conclusion.
  app.patch('/user/repos/:owner/:repo/checks/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      status?: unknown;
      conclusion?: unknown;
      detailsUrl?: unknown;
      outputTitle?: unknown;
      outputSummary?: unknown;
    };
    if (typeof body.status !== 'string') return c.json({ error: 'status is required' }, 400);
    try {
      const run = await createRequestScope(c.env)
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
      return c.json({ check: toCheckJson(run) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to update check' }, toServiceStatus(error));
    }
  });
}

export { registerCheckPublicRoutes, registerCheckUserRoutes, enqueueChecksBestEffort };
export type { CheckApp };
