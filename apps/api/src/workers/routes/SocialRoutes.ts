import type { Hono } from 'hono';
import { requireVisibleRepo, resolvePublicViewer, toRepoJson, withPublicRepo } from './PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { emitWebhookEvent, publishLiveUpdate } from './SocialEmit';

type SocialApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

async function getCounts(env: Env, repoId: string): Promise<{ starsCount: number; watchersCount: number }> {
  const scope = createRequestScope(env);
  const [starsCount, watchersCount] = await Promise.all([
    scope
      .get(Tokens.StarService)
      .countByRepo(repoId)
      .catch(() => 0),
    scope
      .get(Tokens.WatchService)
      .countByRepo(repoId)
      .catch(() => 0),
  ]);
  return { starsCount, watchersCount };
}

// Public star/watch/activity read-model — anonymous OK for public repos
// (private → 404 unless the viewer has read+). Viewer-specific flags resolve
// best-effort and default to false for anonymous visitors.
function registerSocialRoutes(app: SocialApp): void {
  app.get('/repos/:owner/:repo/stars', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      const scope = createRequestScope(c.env);
      const viewerEmail = await resolvePublicViewer(c as never);
      const [starsCount, viewerStarred] = await Promise.all([
        scope
          .get(Tokens.StarService)
          .countByRepo(row.id)
          .catch(() => 0),
        viewerEmail
          ? scope
              .get(Tokens.StarService)
              .isStarred(row.id, viewerEmail)
              .catch(() => false)
          : Promise.resolve(false),
      ]);
      return c.json({ count: starsCount, starsCount, viewerStarred });
    });
  });

  app.get('/repos/:owner/:repo/watches', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      const scope = createRequestScope(c.env);
      const viewerEmail = await resolvePublicViewer(c as never);
      const [watchersCount, viewerWatching] = await Promise.all([
        scope
          .get(Tokens.WatchService)
          .countByRepo(row.id)
          .catch(() => 0),
        viewerEmail
          ? scope
              .get(Tokens.WatchService)
              .isWatching(row.id, viewerEmail)
              .catch(() => false)
          : Promise.resolve(false),
      ]);
      return c.json({ count: watchersCount, watchersCount, viewerWatching });
    });
  });

  app.get('/repos/:owner/:repo/activity', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      const url = new URL(c.req.url);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 30, 1), 100);
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const { events, nextCursor } = await createRequestScope(c.env).get(Tokens.ActivityService).listByRepo(row.id, limit, cursor);
      return c.json({ events, nextCursor });
    });
  });
}

// Protected star/watch toggles + personal lists behind /user/* Access auth.
function registerUserSocialRoutes(app: SocialApp): void {
  app.put('/user/repos/:owner/:repo/star', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const scope = createRequestScope(c.env);
    await scope.get(Tokens.StarService).star(row.id, email);
    await emitWebhookEvent(c.env, {
      repositoryId: row.id,
      fullName: `${owner}/${repoName}`,
      actorEmail: email,
      event: 'star',
      action: 'starred',
    });
    await publishLiveUpdate(c.env, {
      fullName: `${owner}/${repoName}`,
      channel: 'activity',
      type: 'repo.starred',
      actorEmail: email,
      title: `Starred ${owner}/${repoName}`,
    });
    return c.json({ starred: true, ...(await getCounts(c.env, row.id)) });
  });

  app.delete('/user/repos/:owner/:repo/star', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const scope = createRequestScope(c.env);
    await scope.get(Tokens.StarService).unstar(row.id, email);
    await emitWebhookEvent(c.env, {
      repositoryId: row.id,
      fullName: `${owner}/${repoName}`,
      actorEmail: email,
      event: 'star',
      action: 'unstarred',
    });
    return c.json({ starred: false, ...(await getCounts(c.env, row.id)) });
  });

  app.put('/user/repos/:owner/:repo/watch', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const scope = createRequestScope(c.env);
    await scope.get(Tokens.WatchService).watch(row.id, email);
    await emitWebhookEvent(c.env, {
      repositoryId: row.id,
      fullName: `${owner}/${repoName}`,
      actorEmail: email,
      event: 'watch',
      action: 'watching',
    });
    await publishLiveUpdate(c.env, {
      fullName: `${owner}/${repoName}`,
      channel: 'activity',
      type: 'repo.watching',
      actorEmail: email,
      title: `Started Watching ${owner}/${repoName}`,
    });
    return c.json({ watching: true, ...(await getCounts(c.env, row.id)) });
  });

  app.delete('/user/repos/:owner/:repo/watch', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const scope = createRequestScope(c.env);
    await scope.get(Tokens.WatchService).unwatch(row.id, email);
    await emitWebhookEvent(c.env, {
      repositoryId: row.id,
      fullName: `${owner}/${repoName}`,
      actorEmail: email,
      event: 'watch',
      action: 'unwatched',
    });
    return c.json({ watching: false, ...(await getCounts(c.env, row.id)) });
  });

  app.get('/user/stars', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    return c.json({ repos: await listSocialRepos(c.env, email, 'stars') });
  });

  app.get('/user/watches', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    return c.json({ repos: await listSocialRepos(c.env, email, 'watches') });
  });
}

async function listSocialRepos(env: Env, email: string, kind: 'stars' | 'watches'): Promise<unknown[]> {
  const scope = createRequestScope(env);
  const ids =
    kind === 'stars'
      ? await scope
          .get(Tokens.StarService)
          .listRepoIdsByUser(email, 200)
          .catch(() => [])
      : await scope
          .get(Tokens.WatchService)
          .listRepoIdsByUser(email, 200)
          .catch(() => []);
  const repos = [];
  for (const id of ids.slice(0, 200)) {
    const row = await scope
      .get(Tokens.RepoService)
      .getById(id)
      .catch(() => null);
    if (!row) continue;
    const role = await scope
      .get(Tokens.PermissionService)
      .getRole(email, row)
      .catch(() => null);
    if (!role) continue;
    const counts = await getCounts(env, row.id);
    repos.push({ ...(toRepoJson(row, role) as Record<string, unknown>), viewerRole: role, ...counts });
  }
  return repos;
}

export { registerSocialRoutes, registerUserSocialRoutes };
