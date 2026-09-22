import type { Hono } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import { presentSingle } from './IdentityPresenter';
import { RepoFullName } from '@edge-git/shared/utils';
import { runMirrorSync } from '@edge-git/background/transfer/MirrorRunner';
import { jsonError, toSafeErrorMessage, toServiceStatus, getScope } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';

type MirrorApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function waitUntilOf(c: { executionCtx?: unknown }): ((promise: Promise<unknown>) => void) | null {
  try {
    const ctx = c.executionCtx as ExecutionContext | undefined;
    if (typeof ctx?.waitUntil === 'function') return ctx.waitUntil.bind(ctx);
  } catch {
    // ignore — unit tests have no execution context
  }
  return null;
}

// Scheduled pull-mirror from a public https remote. Fast-forward only:
// new branches/tags are created, heads advance when the upstream is a
// descendant, diverged branches are skipped, nothing is ever deleted.
// Repeated failures auto-disable the mirror.
function registerMirrorRoutes(app: MirrorApp): void {
  app.get('/user/repos/:owner/:repo/mirror', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'read');
      const mirror = await scope.get(Tokens.MirrorService).getForRepo(repo.id);
      if (!mirror) return jsonError(c, 'No mirror configured', 404);
      return c.json({ mirror: await presentSingle(scope, mirror) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to load mirror'), toServiceStatus(error));
    }
  });

  app.put('/user/repos/:owner/:repo/mirror', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const { malformed, body } = await readJsonBody<{ sourceUrl?: string; intervalMinutes?: number }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.sourceUrl !== 'string' || !body.sourceUrl.trim()) return jsonError(c, 'sourceUrl is required', 400);
    if (typeof body.intervalMinutes !== 'number') return jsonError(c, 'intervalMinutes is required', 400);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const mirror = await scope.get(Tokens.MirrorService).configure(repo.id, body.sourceUrl, body.intervalMinutes, email);
      return c.json({ mirror: await presentSingle(scope, mirror) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to configure mirror'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/mirror/sync', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const mirror = await scope.get(Tokens.MirrorService).getForRepo(repo.id);
      if (!mirror) return jsonError(c, 'No mirror configured', 404);
      const waitUntil = waitUntilOf(c);
      if (waitUntil) {
        waitUntil(runMirrorSync(c.env, repo.id).catch(() => undefined));
        const refreshed = await scope.get(Tokens.MirrorService).getForRepo(repo.id);
        return c.json({ mirror: refreshed ? await presentSingle(scope, refreshed) : refreshed, sync: 'started' }, 202);
      }
      await runMirrorSync(c.env, repo.id);
      const refreshed = await scope.get(Tokens.MirrorService).getForRepo(repo.id);
      return c.json({ mirror: refreshed ? await presentSingle(scope, refreshed) : refreshed, sync: 'done' });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to sync mirror'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/mirror/enable', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const { malformed, body } = await readJsonBody<{ enabled?: boolean }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.enabled !== 'boolean') return jsonError(c, 'enabled is required', 400);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const mirror = await scope.get(Tokens.MirrorService).setEnabled(repo.id, body.enabled);
      return c.json({ mirror: await presentSingle(scope, mirror) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update mirror'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/mirror', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      await scope.get(Tokens.MirrorService).remove(repo.id);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to remove mirror'), toServiceStatus(error));
    }
  });
}

export { registerMirrorRoutes };
