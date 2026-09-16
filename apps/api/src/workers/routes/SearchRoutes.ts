import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { SearchService } from '@edge-git/backend-services/search';
import { RepoService } from '@edge-git/backend-services/repo';
import { requireVisibleRepo, resolvePublicViewer, toRepoJson, toServiceStatus } from './PublicViewerResolver';
import type { RequestContext } from '@/middleware';

type SearchApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function badQuery(c: { json: (body: unknown, status?: number) => Response }, message: string): Response {
  return c.json({ error: message }, 400);
}

// Public global search — anonymous OK for public content (private rows are
// filtered by SearchService via PermissionService, never leaked).
// GET /search?q=...&type=repos|issues|code&owner=&repo=&limit=
function registerSearchRoutes(app: SearchApp): void {
  app.get('/search', async (c) => {
    const url = new URL(c.req.url);
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!q) return badQuery(c, 'q is required');
    const type = SearchService.parseType(url.searchParams.get('type'));
    const limit = SearchService.clampLimit(url.searchParams.get('limit'));
    const owner = (url.searchParams.get('owner') ?? '').trim();
    const repoParam = (url.searchParams.get('repo') ?? '').trim();

    let viewerEmail: string | null = null;
    try {
      viewerEmail = await resolvePublicViewer(c as never as RequestContext);
    } catch {
      viewerEmail = null;
    }

    try {
      const scope = createRequestScope(c.env);
      const svc = scope.get(Tokens.SearchService);
      if (owner && repoParam) {
        const repoName = RepoService.normalizeRepo(repoParam);
        const row = await requireVisibleRepo(c.env, owner, repoName, viewerEmail);
        if (!row) return c.json({ error: 'Not found' }, 404);
        if (type === 'issues') {
          const issues = await svc.searchIssues(q, viewerEmail, { limit, repoId: row.id });
          return c.json({ type, query: q, issues });
        }
        if (type === 'code') {
          const code = await svc.searchCode(q, viewerEmail, { limit, repoId: row.id });
          return c.json({ type, query: q, code });
        }
        const repos = await svc.searchRepos(q, viewerEmail, limit);
        return c.json({ type, query: q, repos: repos.filter((r) => r.id === row.id).map((r) => toRepoJson(r)) });
      }
      if (type === 'issues') {
        const issues = await svc.searchIssues(q, viewerEmail, { limit });
        return c.json({ type, query: q, issues });
      }
      if (type === 'code') {
        const code = await svc.searchCode(q, viewerEmail, { limit });
        return c.json({ type, query: q, code });
      }
      const repos = await svc.searchRepos(q, viewerEmail, limit);
      return c.json({ type, query: q, repos: repos.map((r) => toRepoJson(r)) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Search failed';
      if (message.includes('at least 2 characters') || message.includes('at most')) return badQuery(c, message);
      return c.json({ error: message }, toServiceStatus(error));
    }
  });
}

export { registerSearchRoutes };
