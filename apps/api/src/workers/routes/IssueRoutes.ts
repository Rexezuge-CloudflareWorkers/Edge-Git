import type { Hono } from 'hono';
import { requireVisibleRepo, withPublicRepo } from './PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';

type IssueApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function registerIssueRoutes(app: IssueApp): void {
  app.get('/repos/:owner/:repo/issues', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      const issues = await createRequestScope(c.env).get(Tokens.IssueService).listByRepo(row.id, 50);
      return c.json({ issues });
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
    const created = await createRequestScope(c.env).get(Tokens.IssueService).createIssue({
      repositoryId: row.id,
      fullName: `${owner}/${repoName}`,
      title: body.title,
      body: body.body ?? null,
      creatorEmail: email,
    });
    return c.json(created, 201);
  });
}

export { registerIssueRoutes, registerUserIssueRoutes };
