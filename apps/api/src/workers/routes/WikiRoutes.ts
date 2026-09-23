import type { Hono } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import { recordAndNotify } from './SocialEmit';
import { jsonError, requireVisibleRepo, toSafeErrorMessage, toServiceStatus, withPublicRepo, getScope } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';
import { presentMany, presentSingle } from './IdentityPresenter';

type WikiApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function registerWikiPublicRoutes(app: WikiApp): void {
  app.get('/repos/:owner/:repo/wiki', async (c) => {
    return withPublicRepo(c, async (row) => {
      const url = new URL(c.req.url);
      const q = (url.searchParams.get('q') ?? '').trim();
      try {
        const scope = getScope(c);
        if (q) {
          const pages = await scope.get(Tokens.WikiService).searchPages(row.id, q);
          return c.json({ pages: await presentMany(scope, pages) });
        }
        const pages = await scope.get(Tokens.WikiService).listPages(row.id);
        return c.json({ pages: await presentMany(scope, pages) });
      } catch {
        return c.json({ pages: [] });
      }
    });
  });

  app.get('/repos/:owner/:repo/wiki/:slug', async (c) => {
    return withPublicRepo(c, async (row) => {
      try {
        const scope = getScope(c);
        const page = await scope.get(Tokens.WikiService).getPage(row.id, c.req.param('slug'));
        return c.json({ page: await presentSingle(scope, page) });
      } catch (error) {
        return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
      }
    });
  });
}

function registerWikiUserRoutes(app: WikiApp): void {
  app.get('/user/repos/:owner/:repo/wiki', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const row = await requireVisibleRepo(c.env, c.req.param('owner'), RepoFullName.normalizeRepo(c.req.param('repo')), email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      const url = new URL(c.req.url);
      const q = (url.searchParams.get('q') ?? '').trim();
      const scope = getScope(c);
      const pages = q ? await scope.get(Tokens.WikiService).searchPages(row.id, q) : await scope.get(Tokens.WikiService).listPages(row.id);
      return c.json({ pages: await presentMany(scope, pages) });
    } catch {
      return c.json({ pages: [] });
    }
  });

  app.post('/user/repos/:owner/:repo/wiki', async (c) => {
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
    const { malformed, oversized, body } = await readJsonBody<{ slug: unknown; title: unknown; body?: unknown }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
      const page = await scope.get(Tokens.WikiService).createPage(row.id, body, email);
      void recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName: `${row.owner}/${row.name}`,
        actorEmail: email,
        type: 'wiki_created',
        title: `Wiki page ${page.slug} created`,
        subjectType: 'wiki',
        subjectOid: page.slug,
        payload: { slug: page.slug, title: page.title },
      });
      return c.json({ page: await presentSingle(scope, page) }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create wiki page'), toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/wiki/:slug', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const row = await requireVisibleRepo(c.env, c.req.param('owner'), RepoFullName.normalizeRepo(c.req.param('repo')), email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      const scope = getScope(c);
      const page = await scope.get(Tokens.WikiService).getPage(row.id, c.req.param('slug'));
      return c.json({ page: await presentSingle(scope, page) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/wiki/:slug/revisions', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const row = await requireVisibleRepo(c.env, c.req.param('owner'), RepoFullName.normalizeRepo(c.req.param('repo')), email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      const scope = getScope(c);
      const revisions = await scope.get(Tokens.WikiService).listRevisions(row.id, c.req.param('slug'));
      return c.json({ revisions: await presentMany(scope, revisions) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.put('/user/repos/:owner/:repo/wiki/:slug', async (c) => {
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
    const { malformed, oversized, body } = await readJsonBody<{ title?: unknown; body?: unknown; expectedRevision?: unknown }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
      const page = await scope.get(Tokens.WikiService).updatePage(row.id, c.req.param('slug'), body, email);
      void recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName: `${row.owner}/${row.name}`,
        actorEmail: email,
        type: 'wiki_updated',
        title: `Wiki page ${page.slug} updated`,
        subjectType: 'wiki',
        subjectOid: page.slug,
        payload: { slug: page.slug, revision: page.revision },
      });
      return c.json({ page: await presentSingle(scope, page) });
    } catch (error) {
      const status = toServiceStatus(error);
      const message = error instanceof Error ? error.message : 'Failed to update wiki page';
      // Optimistic-concurrency conflicts surface as 409; map the service
      // ConflictError (500 by default) explicitly.
      if (message.startsWith('revision conflict')) return jsonError(c, message, 409);
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update wiki page'), status === 500 ? 400 : status);
    }
  });

  app.delete('/user/repos/:owner/:repo/wiki/:slug', async (c) => {
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
    try {
      await getScope(c).get(Tokens.WikiService).deletePage(row.id, c.req.param('slug'));
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });
}

export { registerWikiPublicRoutes, registerWikiUserRoutes };
export type { WikiApp };
