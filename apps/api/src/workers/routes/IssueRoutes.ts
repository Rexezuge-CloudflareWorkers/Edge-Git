import type { Hono } from 'hono';
import { jsonError, requireVisibleRepo, toSafeErrorMessage, toServiceStatus, withPublicRepo, getScope } from './PublicViewerResolver';
import { recordAndNotify } from './SocialEmit';
import { Tokens } from '@edge-git/backend-services/composition';
import { RepoFullName, mapWithConcurrency } from '@edge-git/shared/utils';
import { parsePositiveInt } from '@edge-git/shared/validation';
import { readJsonBody } from './BodyParser';
import { presentMany, presentSingle } from './IdentityPresenter';

type IssueApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

const MAX_ISSUE_TITLE = 200;
const MAX_ISSUE_BODY = 10_000;
const MAX_FILTER_CHARS = 100;
const ISSUE_STATUSES = new Set(['open', 'closed']);

function parseIssueNumber(raw: string | undefined): number | null {
  return parsePositiveInt(raw ?? null);
}

function sanitizeFilter(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().slice(0, MAX_FILTER_CHARS);
  if (!trimmed) return null;
  // Reject control chars via code points (not regex); why: filters reach SQL LIKE.
  for (const ch of trimmed) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x7f || code <= 0x1f) return null;
  }
  return trimmed;
}

async function filterIssuesByMeta(
  scope: ReturnType<typeof getScope>,
  issues: Array<{ id: string; milestone_id?: string | null }>,
  filters: { label: string | null; assignee: string | null; milestone: string | null },
): Promise<typeof issues> {
  const collab = scope.get(Tokens.CollaborationService);
  // Concurrent meta fan-out capped at 10 (was sequential N+1 up to 50).
  // Per-issue failures degrade to empty meta; outer failures fall back to
  // unfiltered (filters are best-effort on public reads).
  const metas = await mapWithConcurrency(issues, 10, (issue) => collab.getIssueMeta(issue.id).catch(() => ({ labels: [], assignees: [] })));
  const labelLower = filters.label?.toLowerCase() ?? null;
  const assigneeLower = filters.assignee?.toLowerCase() ?? null;
  return issues.filter((issue, i) => {
    if (filters.milestone && (issue as { milestone_id?: string | null }).milestone_id !== filters.milestone) return false;
    const meta = metas[i] as { labels: Array<{ name: string }>; assignees: string[] };
    if (labelLower && meta.labels.every((l) => l.name.toLowerCase() !== labelLower)) return false;
    if (assigneeLower && meta.assignees.every((a) => a.toLowerCase() !== assigneeLower)) return false;
    return true;
  });
}

function registerIssueRoutes(app: IssueApp): void {
  app.get('/repos/:owner/:repo/issues', async (c) => {
    return withPublicRepo(c, async (row) => {
      const scope = getScope(c);
      const issues = await scope.get(Tokens.IssueService).listByRepo(row.id, 50);
      const label = sanitizeFilter(c.req.query('label'));
      const assigneeRaw = sanitizeFilter(c.req.query('assignee'));
      const assignee = assigneeRaw?.toLowerCase() ?? null;
      const milestone = sanitizeFilter(c.req.query('milestone'));
      if (!label && !assignee && !milestone) return c.json({ issues: await presentMany(scope, issues) });
      try {
        const filtered = await filterIssuesByMeta(scope, issues, { label, assignee, milestone });
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
    const label = sanitizeFilter(c.req.query('label'));
    const assigneeRaw = sanitizeFilter(c.req.query('assignee'));
    const assignee = assigneeRaw?.toLowerCase() ?? null;
    const milestone = sanitizeFilter(c.req.query('milestone'));
    if (!label && !assignee && !milestone) return c.json({ issues: await presentMany(scope, issues) });
    try {
      const filtered = await filterIssuesByMeta(scope, issues, { label, assignee, milestone });
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
    const { malformed, oversized, body } = await readJsonBody<{ title?: string; body?: string }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return jsonError(c, 'title is required', 400);
    if (title.length > MAX_ISSUE_TITLE) return jsonError(c, `title must be at most ${MAX_ISSUE_TITLE} characters`, 400);
    if (typeof body.body === 'string' && body.body.length > MAX_ISSUE_BODY)
      return jsonError(c, `body must be at most ${MAX_ISSUE_BODY} characters`, 400);
    const scope = getScope(c);
    const created = await scope.get(Tokens.IssueService).createIssue({
      repositoryId: row.id,
      title,
      body: body.body ?? null,
      creatorEmail: email,
    });
    await recordAndNotify(c.env, {
      repositoryId: row.id,
      fullName: `${owner}/${repoName}`,
      actorEmail: email,
      type: 'issue_opened',
      title: `Issue #${created.number} ${title}`,
      subjectType: 'issue',
      subjectNumber: created.number,
      mentionText: `${title}\n${body.body ?? ''}`,
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
    const { malformed, oversized, body } = await readJsonBody<{ status?: string }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    const status = typeof body.status === 'string' ? body.status.trim().toLowerCase() : '';
    if (!ISSUE_STATUSES.has(status)) return jsonError(c, 'status must be open or closed', 400);
    try {
      const scope = getScope(c);
      const issue = await scope.get(Tokens.IssueService).updateStatus({ repositoryId: row.id, number, status });
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
    const { malformed, oversized, body } = await readJsonBody<{ body?: string }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.body !== 'string' || !body.body.trim()) return jsonError(c, 'body is required', 400);
    if (body.body.length > MAX_ISSUE_BODY) return jsonError(c, `body must be at most ${MAX_ISSUE_BODY} characters`, 400);
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

export { registerIssueRoutes, registerUserIssueRoutes, sanitizeFilter, filterIssuesByMeta, parseIssueNumber };
export { MAX_ISSUE_TITLE, MAX_ISSUE_BODY, MAX_FILTER_CHARS, ISSUE_STATUSES };
