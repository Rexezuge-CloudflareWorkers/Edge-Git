import { jsonError, toSafeErrorMessage, toServiceStatus, getScope } from '../PublicViewerResolver';
import { requireVisibleRepo } from '../PublicViewerResolver';
import { recordAndNotify } from '../SocialEmit';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import { suggestCodeownerHandles } from '../CodeownerHelpers';
import { needWrite, parseNumber } from './CollabHelpers';
import type { CollabApp } from './CollabHelpers';
import { readJsonBody } from '../BodyParser';
import { presentSingle, usernameFor, usernameMap } from '../IdentityPresenter';

type RequestScope = ReturnType<typeof createRequestScope>;

// `assignees` come back as raw email string lists; expose usernames instead.
async function presentAssignees(scope: RequestScope, emails: unknown[]): Promise<string[]> {
  const cleaned = emails.filter((e): e is string => typeof e === 'string' && e.length > 0);
  const map = await usernameMap(scope, cleaned);
  return cleaned.map((e) => usernameFor(map, e));
}

// Reviewer rows carry `user_email` (no `role` key). `presentOne` now maps
// those to `username` as well; this helper stays as the explicit path for
// reviewer lists so the mapping is covered even if row shapes drift.
async function presentReviewers(
  scope: RequestScope,
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const map = await usernameMap(
    scope,
    rows.map((r) => r['user_email']).filter((e): e is string => typeof e === 'string' && e.length > 0),
  );
  return rows.map((r) => {
    const { user_email, ...rest } = r;
    return { ...rest, username: usernameFor(map, typeof user_email === 'string' ? user_email : undefined) };
  });
}

function registerCollabPullTriageRoutes(app: CollabApp): void {
  // Pull triage: labels / assignees / milestone + meta
  app.get('/user/repos/:owner/:repo/pulls/:number/meta', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const scope = getScope(c);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      let meta = { labels: [], assignees: [], reviewers: [] } as { labels: unknown[]; assignees: unknown[]; reviewers: unknown[] };
      try {
        meta = await scope.get(Tokens.CollaborationService).getPullMeta(pull.id);
      } catch {
        // legacy DB without collab tables
      }
      return c.json({
        pull: await presentSingle(scope, pull),
        labels: meta.labels,
        assignees: await presentAssignees(scope, meta.assignees),
        reviewers: await presentReviewers(scope, meta.reviewers as Array<Record<string, unknown>>),
      });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  for (const kind of ['labels', 'assignees', 'milestone'] as const) {
    app.put(`/user/repos/:owner/:repo/pulls/:number/${kind}`, async (c) => {
      const email = c.get('AuthenticatedUserEmailAddress');
      const owner = c.req.param('owner');
      const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
      const row = await requireVisibleRepo(c.env, owner, repoName, email);
      if (!row) return jsonError(c, 'Not found', 404);
      if (!(await needWrite(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
      const number = parseNumber(c.req.param('number'));
      if (number === null) return jsonError(c, 'Not found', 404);
      const { malformed, body } = await readJsonBody<{ labelIds?: string[]; assignees?: string[]; milestoneId?: string | null }>(c);
      if (malformed) return jsonError(c, 'Invalid JSON body', 400);
      try {
        const scope = getScope(c);
        const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
        const collab = scope.get(Tokens.CollaborationService);
        if (kind === 'labels') await collab.setPullLabels(pull.id, row.id, body.labelIds ?? []);
        else if (kind === 'assignees') await collab.setPullAssignees(pull.id, body.assignees ?? []);
        else await collab.setPullMilestone(pull.id, row.id, body.milestoneId ?? null);
        return c.json({ ok: true });
      } catch (error) {
        return jsonError(c, toSafeErrorMessage(error, 'Failed to update pull request'), toServiceStatus(error));
      }
    });
  }

  // Reviewers + drafts + CODEOWNERS suggestions
  app.get('/user/repos/:owner/:repo/pulls/:number/reviewers', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const scope = getScope(c);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      const reviewers = await scope
        .get(Tokens.CollaborationService)
        .listReviewers(pull.id)
        .catch(() => []);
      return c.json({ reviewers: await presentReviewers(scope, reviewers as Array<Record<string, unknown>>) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/pulls/:number/reviewers', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{ reviewers?: string[] }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      await scope.get(Tokens.CollaborationService).requestReviewers(pull.id, body.reviewers ?? []);
      await recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName: `${owner}/${repoName}`,
        actorEmail: email,
        type: 'pr_commented',
        title: `Review requested on pull request #${pull.number}: ${pull.title}`,
        subjectType: 'pull',
        subjectNumber: pull.number,
        participantEmails: [pull.creator_email],
        mentionText: Array.isArray(body.reviewers) ? body.reviewers.join(' ') : null,
      }).catch(() => undefined);
      return c.json({ ok: true }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to request reviewers'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/pulls/:number/reviewers/:reviewer', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const scope = getScope(c);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      await scope.get(Tokens.CollaborationService).removeReviewer(pull.id, decodeURIComponent(c.req.param('reviewer')));
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/pulls/:number/draft', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{ isDraft?: boolean }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.isDraft !== 'boolean') return jsonError(c, 'isDraft must be a boolean', 400);
    try {
      const scope = getScope(c);
      const pull = await scope.get(Tokens.PullRequestService).setDraft(row.id, number, body.isDraft);
      return c.json({ pull: await presentSingle(scope, pull) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update draft'), toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/pulls/:number/codeowners', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const scope = getScope(c);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      const fullName = `${owner}/${repoName}`;
      // Suggest owners from files changed in the PR diff (cap 50 paths).
      const suggested = await suggestCodeownerHandles(c.env, fullName, {
        baseBranch: pull.base_branch,
        baseOid: pull.base_oid ?? null,
        headOid: pull.head_oid ?? null,
      });
      return c.json(suggested);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });
}

export { registerCollabPullTriageRoutes };
