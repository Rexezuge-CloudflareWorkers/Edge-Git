import type { Hono } from 'hono';
import { ensureRepo, getRepoStub } from '../repoStub';
import { requireVisibleRepo, resolvePublicViewer, toRepoJson, toServiceStatus, withPublicRepo } from './PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { copyRepoGit, isPackLimitError } from './CrossFork';
import { recordAndNotify } from './SocialEmit';

type ForkApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function toForkJson(row: Parameters<typeof toRepoJson>[0], forksCount?: number): unknown {
  const base = toRepoJson(row) as Record<string, unknown>;
  return forksCount === undefined ? base : { ...base, forksCount };
}

// Public fork listing — anonymous OK for public sources (private → 404).
// Private forks are filtered unless the viewer has read+ on them.
function registerForkRoutes(app: ForkApp): void {
  app.get('/repos/:owner/:repo/forks', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      const scope = createRequestScope(c.env);
      const viewerEmail = await resolvePublicViewer(c as never);
      const permission = scope.get(Tokens.PermissionService);
      const forks = await scope.get(Tokens.ForkService).listForks(row.id, 100);
      const visible = [];
      for (const fork of forks) {
        const role = await permission.getRole(viewerEmail, fork).catch(() => null);
        if (role) visible.push(toForkJson(fork));
      }
      return c.json({ forks: visible, count: visible.length });
    });
  });
}

// Protected fork creation behind /user/* Access auth. The caller specifies
// the destination `{owner, name}` (defaults: own username, source name).
function registerUserForkRoutes(app: ForkApp): void {
  app.post('/user/repos/:owner/:repo/forks', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const body = (await c.req.json().catch(() => ({}))) as { owner?: string; name?: string; description?: string | null; isPrivate?: boolean };
    const scope = createRequestScope(c.env);
    let fork: { id: string; owner: string; name: string; fullName: string; isPrivate: boolean };
    try {
      fork = await scope.get(Tokens.ForkService).createForkRow(email, owner, repoName, body);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to fork repository' }, toServiceStatus(error));
    }
    const sourceFullName = `${owner}/${repoName}`;
    try {
      await ensureRepo(c.env, fork.fullName);
      await copyRepoGit(c.env, sourceFullName, fork.fullName);
    } catch (error) {      // Roll back the fork so a failed copy never leaves a half-made repo.
      await scope.get(Tokens.ForkService).rollbackFork(fork.id);
      try {
        await getRepoStub(c.env, fork.fullName).deleteRepo();
      } catch {
        // best-effort DO purge
      }
      if (isPackLimitError(error)) {
        return c.json({ error: error instanceof Error ? error.message : 'Repository too large to fork' }, 413);
      }
      return c.json({ error: 'Failed to copy repository data' }, 500);
    }
    await scope.get(Tokens.WatchService).ensureWatching(fork.id, email).catch(() => undefined);
    const sourceRow = await scope.get(Tokens.RepoService).getByOwnerAndName(owner, repoName).catch(() => null);
    if (sourceRow) {
      await recordAndNotify(c.env, {
        repositoryId: sourceRow.id,
        fullName: sourceFullName,
        actorEmail: email,
        type: 'fork_created',
        title: `${email} forked ${sourceFullName} to ${fork.fullName}`,
        payload: { fork: fork.fullName },
      });
    }
    return c.json({ id: fork.id, owner: fork.owner, name: fork.name, fullName: fork.fullName, forkedFrom: sourceFullName, isPrivate: fork.isPrivate }, 201);
  });

  app.get('/user/repos/:owner/:repo/forks', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const scope = createRequestScope(c.env);
    const permission = scope.get(Tokens.PermissionService);
    const forks = await scope.get(Tokens.ForkService).listForks(row.id, 100);
    const visible = [];
    for (const fork of forks) {
      const role = await permission.getRole(email, fork).catch(() => null);
      if (role) visible.push(toForkJson(fork));
    }
    return c.json({ forks: visible, count: visible.length });
  });
}

export { registerForkRoutes, registerUserForkRoutes };
