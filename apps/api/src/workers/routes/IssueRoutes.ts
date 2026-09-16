import type { Hono } from 'hono';
import { requireVisibleRepo, toServiceStatus, withPublicRepo } from './PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';

type IssueApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function parseIssueNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

function registerIssueRoutes(app: IssueApp): void {
  app.get('/repos/:owner/:repo/issues', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      const issues = await createRequestScope(c.env).get(Tokens.IssueService).listByRepo(row.id, 50);
      return c.json({ issues });
    });
  });

  app.get('/repos/:owner/:repo/issues/:number', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      const number = parseIssueNumber(c.req.param('number'));
      if (number === null) return c.json({ error: 'Not found' }, 404);
      try {
        const issue = await createRequestScope(c.env).get(Tokens.IssueService).getByNumber(row.id, number);
        return c.json({ issue });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
      }
    });
  });

  app.get('/repos/:owner/:repo/issues/:number/comments', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      const number = parseIssueNumber(c.req.param('number'));
      if (number === null) return c.json({ error: 'Not found' }, 404);
      try {
        const comments = await createRequestScope(c.env).get(Tokens.IssueService).listComments(row.id, number);
        return c.json({ comments });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
      }
    });
  });
}

function registerUserIssueRoutes(app: IssueApp): void {
  app.get('/user/repos/:owner/:repo/issues', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    const issues = await createRequestScope(c.env).get(Tokens.IssueService).listByRepo(row.id, 50);
    return c.json({ issues });
  });

  app.post('/user/repos/:owner/:repo/issues', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; body?: string };
    if (!body.title) return c.json({ error: 'title is required' }, 400);
    const created = await createRequestScope(c.env)
      .get(Tokens.IssueService)
      .createIssue({
        repositoryId: row.id,
        fullName: `${owner}/${repoName}`,
        title: body.title,
        body: body.body ?? null,
        creatorEmail: email,
      });
    return c.json(created, 201);
  });

  app.get('/user/repos/:owner/:repo/issues/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parseIssueNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    try {
      const issue = await createRequestScope(c.env).get(Tokens.IssueService).getByNumber(row.id, number);
      return c.json({ issue });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/issues/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    // Write+ (collaborator write, org member with grant, or admin/owner) may triage issues.
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const number = parseIssueNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    try {
      const issue = await createRequestScope(c.env)
        .get(Tokens.IssueService)
        .updateStatus({ repositoryId: row.id, number, status: body.status ?? '' });
      return c.json({ issue });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to update issue' }, toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/issues/:number/comments', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parseIssueNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    try {
      const comments = await createRequestScope(c.env).get(Tokens.IssueService).listComments(row.id, number);
      return c.json({ comments });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/issues/:number/comments', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parseIssueNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { body?: string };
    if (typeof body.body !== 'string' || !body.body.trim()) return c.json({ error: 'body is required' }, 400);
    try {
      const comment = await createRequestScope(c.env).get(Tokens.IssueService).addComment({
        repositoryId: row.id,
        number,
        authorEmail: email,
        body: body.body,
      });
      return c.json({ comment }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to add comment' }, toServiceStatus(error));
    }
  });
}

export { registerIssueRoutes, registerUserIssueRoutes };
