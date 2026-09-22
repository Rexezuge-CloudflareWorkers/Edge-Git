import type { Hono } from 'hono';
import { jsonError, requireVisibleRepo, toSafeErrorMessage, toServiceStatus, withPublicRepo, getScope } from './PublicViewerResolver';
import { recordAndNotify } from './SocialEmit';
import { Tokens } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import { parsePositiveInt } from '@edge-git/shared/validation';
import { readJsonBody } from './BodyParser';
import { presentMany, presentSingle } from './IdentityPresenter';

type IssueApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function parseIssueNumber(raw: string | undefined): number | null {
  return parsePositiveInt(raw ?? null);
}

function registerIssueRoutes(app: IssueApp): void {
  app.get('/repos/:owner/:repo/issues', async (c) => {
    return withPublicRepo(c, async (row) => {
      const scope = getScope(c);
      const issues = await scope.get(Tokens.IssueService).listByRepo(row.id, 50);
      const label = c.req.query('label');
      const assignee = c.req.query('assignee')?.toLowerCase();
      const milestone = c.req.query('milestone');
      if (!label && !assignee && !milestone) return c.json({ issues: await presentMany(scope, issues) });
      try {
        const collab = scope.get(Tokens.CollaborationService);
        const filtered: typeof issues = [];
        for (const issue of issues) {
          if (milestone && (issue as { milestone_id?: string | null }).milestone_id !== milestone) continue;
          const meta = await collab.getIssueMeta(issue.id).catch(() => ({ labels: [], assignees: [] }));
          if (label && (meta.labels as Array<{ name: string }>).every((l) => l.name.toLowerCase() !== label.toLowerCase())) continue;
          if (assignee && (meta.assignees as string[]).every((a) => a.toLowerCase() !== assignee)) continue;
          filtered.push(issue);
        }
        return c.json({ issues: await presentMany(scope, filtered) });
      } catch {
        return c.json({ issues: await presentMany(scope, issues) });
      }
    });
  });

  app.get('/repos/:owner/:repo/issues/:number', async (c) => {
    return withPublicRepo(c, async (row) => {
      const number = parseIssueNumber(c.req.param('number'));
      if (number === null) return jsonError(c, 'Not found', 404);
      try {
        const scope = getScope(c);
        const issue = await scope.get(Tokens.IssueService).getByNumber(row.id, number);
        return c.json({ issue: await presentSingle(scope, issue) });
      } catch (error) {
        return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
      }
    });
  });

  app.get('/repos/:owner/:repo/issues/:number/comments', async (c) => {
    return withPublicRepo(c, async (row) => {
      const number = parseIssueNumber(c.req.param('number'));
      if (number === null) return jsonError(c, 'Not found', 404);
      try {
        const scope = getScope(c);
        const comments = await scope.get(Tokens.IssueService).listComments(row.id, number);
        return c.json({ comments: await presentMany(scope, comments) });
      } catch (error) {
        return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
      }
    });
  });
}

function registerUserIssueRoutes(app: IssueApp): void {
  app.get('/user/repos/:owner/:repo/issues', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return jsonError(c, 'Not found', 404);
    const scope = getScope(c);
    const issues = await scope.get(Tokens.IssueService).listByRepo(row.id, 50);
    const label = c.req.query('label');
    const assignee = c.req.query('assignee')?.toLowerCase();
    const milestone = c.req.query('milestone');
    if (!label && !assignee && !milestone) return c.json({ issues: await presentMany(scope, issues) });
    try {
      const collab = scope.get(Tokens.CollaborationService);
      const filtered: typeof issues = [];
      for (const issue of issues) {
        if (milestone && (issue as { milestone_id?: string | null }).milestone_id !== milestone) continue;
        const meta = await collab.getIssueMeta(issue.id).catch(() => ({ labels: [], assignees: [] }));
        if (label && (meta.labels as Array<{ name: string }>).every((l) => l.name.toLowerCase() !== label.toLowerCase())) continue;
        if (assignee && (meta.assignees as string[]).every((a) => a.toLowerCase() !== assignee)) continue;
        filtered.push(issue);
      }
      return c.json({ issues: await presentMany(scope, filtered) });
    } catch {
      return c.json({ issues });
    }
  });

  app.post('/user/repos/:owner/:repo/issues', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{ title?: string; body?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (!body.title) return jsonError(c, 'title is required', 400);
    const scope = getScope(c);
    const created = await scope
      .get(Tokens.IssueService)
      .createIssue({
        repositoryId: row.id,
        fullName: `${owner}/${repoName}`,
        title: body.title,
        body: body.body ?? null,
        creatorEmail: email,
      });
    await recordAndNotify(c.env, {
      repositoryId: row.id,
      fullName: `${owner}/${repoName}`,
      actorEmail: email,
      type: 'issue_opened',
      title: `Issue #${created.number} ${body.title}`,
      subjectType: 'issue',
      subjectNumber: created.number,
      mentionText: `${body.title}\n${body.body ?? ''}`,
    });
    return c.json(await presentSingle(scope, created), 201);
  });

  app.get('/user/repos/:owner/:repo/issues/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseIssueNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const scope = getScope(c);
      const issue = await scope.get(Tokens.IssueService).getByNumber(row.id, number);
      return c.json({ issue: await presentSingle(scope, issue) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/issues/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    // Write+ (collaborator write, org member with grant, or admin/owner) may triage issues.
    try {
      await getScope(c).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return jsonError(c, 'Forbidden', 403);
    }
    const number = parseIssueNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{ status?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
      const issue = await scope
        .get(Tokens.IssueService)
        .updateStatus({ repositoryId: row.id, number, status: body.status ?? '' });
      await recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName: `${owner}/${repoName}`,
        actorEmail: email,
        type: issue.status === 'closed' ? 'issue_closed' : 'issue_reopened',
        title: `Issue #${issue.number} ${issue.status === 'closed' ? 'closed' : 'reopened'}: ${issue.title}`,
        subjectType: 'issue',
        subjectNumber: issue.number,
        participantEmails: [issue.creator_email],
      });
      return c.json({ issue: await presentSingle(scope, issue) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update issue'), toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/issues/:number/comments', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseIssueNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const scope = getScope(c);
      const comments = await scope.get(Tokens.IssueService).listComments(row.id, number);
      return c.json({ comments: await presentMany(scope, comments) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/issues/:number/comments', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseIssueNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{ body?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.body !== 'string' || !body.body.trim()) return jsonError(c, 'body is required', 400);
    try {
      const scope = getScope(c);
      const issue = await scope.get(Tokens.IssueService).getByNumber(row.id, number);
      const comment = await scope.get(Tokens.IssueService).addComment({
        repositoryId: row.id,
        number,
        authorEmail: email,
        body: body.body,
      });
      await recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName: `${owner}/${repoName}`,
        actorEmail: email,
        type: 'issue_commented',
        title: `New comment on issue #${issue.number}: ${issue.title}`,
        subjectType: 'issue',
        subjectNumber: issue.number,
        participantEmails: [issue.creator_email],
        mentionText: body.body,
      });
      return c.json({ comment: await presentSingle(scope, comment) }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to add comment'), toServiceStatus(error));
    }
  });
}

export { registerIssueRoutes, registerUserIssueRoutes };
