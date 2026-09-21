import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { presentMany } from './IdentityPresenter';
import { SearchService } from '@edge-git/backend-services/search';
import { RepoFullName } from '@edge-git/shared/utils';
import { jsonError, requireVisibleRepo, resolvePublicViewer, toRepoJson, toSafeErrorMessage, toServiceStatus } from './PublicViewerResolver';
import type { RequestContext } from '@/middleware';

type SearchApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function badQuery(c: RequestContext, message: string): Response {
  return jsonError(c, message, 400);
}

// Public global search — anonymous OK for public content (private rows are
// filtered by SearchService via PermissionService, never leaked).
// GET /search?q=...&type=repos|issues|pulls|code&owner=&repo=&limit=
function registerSearchRoutes(app: SearchApp): void {
  app.get('/search', async (c) => {
    const url = new URL(c.req.url);
    const rawQ = (url.searchParams.get('q') ?? '').trim();
    if (!rawQ) return badQuery(c, 'q is required');
    if (rawQ.length > 200) return badQuery(c, 'q must be at most 200 characters');
    const q = [...rawQ].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    }).join('').trim();
    if (!q) return badQuery(c, 'q is required');
    const type = SearchService.parseType(url.searchParams.get('type'));
    const limit = SearchService.clampLimit(url.searchParams.get('limit'));
    const owner = (url.searchParams.get('owner') ?? '').trim();
    const repoParam = (url.searchParams.get('repo') ?? '').trim();

    let viewerEmail: string | null = null;
    try {
      viewerEmail = await resolvePublicViewer(c);
    } catch {
      viewerEmail = null;
    }

    try {
      const scope = createRequestScope(c.env);
      const svc = scope.get(Tokens.SearchService);
      if (owner && repoParam) {
        const repoName = RepoFullName.normalizeRepo(repoParam);
        const row = await requireVisibleRepo(c.env, owner, repoName, viewerEmail);
        if (!row) return jsonError(c, 'Not found', 404);
        if (type === 'issues') {
          const issues = await svc.searchIssues(q, viewerEmail, { limit, repoId: row.id });
          return c.json({ type, query: q, issues: await presentMany(scope, issues) });
        }
        if (type === 'pulls') {
          const pulls = await svc.searchPulls(q, viewerEmail, { limit, repoId: row.id });
          return c.json({ type, query: q, pulls: await presentMany(scope, pulls) });
        }
        if (type === 'code') {
          const code = await svc.searchCode(q, viewerEmail, { limit, repoId: row.id });
          return c.json({ type, query: q, code });
        }
        if (type === 'discussions') {
          const discussions = await svc.searchDiscussions(q, viewerEmail, { limit, repoId: row.id });
          return c.json({ type, query: q, discussions: await presentMany(scope, discussions) });
        }
        if (type === 'snippets') {
          const snippets = await svc.searchSnippets(q, { limit });
          return c.json({ type, query: q, snippets: await presentMany(scope, snippets) });
        }
        const repos = await svc.searchRepos(q, viewerEmail, limit);
        return c.json({ type, query: q, repos: repos.filter((r) => r.id === row.id).map((r) => toRepoJson(r)) });
      }
      if (type === 'issues') {
        const issues = await svc.searchIssues(q, viewerEmail, { limit });
        return c.json({ type, query: q, issues: await presentMany(scope, issues) });
      }
      if (type === 'pulls') {
        const pulls = await svc.searchPulls(q, viewerEmail, { limit });
        return c.json({ type, query: q, pulls: await presentMany(scope, pulls) });
      }
      if (type === 'code') {
        const code = await svc.searchCode(q, viewerEmail, { limit });
        return c.json({ type, query: q, code });
      }
      if (type === 'discussions') {
        const discussions = await svc.searchDiscussions(q, viewerEmail, { limit });
        return c.json({ type, query: q, discussions: await presentMany(scope, discussions) });
      }
      if (type === 'snippets') {
        const snippets = await svc.searchSnippets(q, { limit });
        return c.json({ type, query: q, snippets });
      }
      const repos = await svc.searchRepos(q, viewerEmail, limit);
      return c.json({ type, query: q, repos: repos.map((r) => toRepoJson(r)) });
    } catch (error) {
      const message = toSafeErrorMessage(error, 'Search failed');
      if (message.includes('at least 2 characters') || message.includes('at most')) return badQuery(c, message);
      return jsonError(c, message, toServiceStatus(error));
    }
  });
}

export { registerSearchRoutes };
