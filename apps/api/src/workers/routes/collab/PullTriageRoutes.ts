import { jsonError, toSafeErrorMessage, toServiceStatus } from '../PublicViewerResolver';
import { requireVisibleRepo } from '../PublicViewerResolver';
import { recordAndNotify } from '../SocialEmit';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { suggestCodeownerHandles } from '../CodeownerHelpers';
import { needWrite, parseNumber } from './CollabHelpers';
import type { CollabApp } from './CollabHelpers';
import { readJsonBody } from '../BodyParser';

function registerCollabPullTriageRoutes(app: CollabApp): void {
  // Pull triage: labels / assignees / milestone + meta
  app.get('/user/repos/:owner/:repo/pulls/:number/meta', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const scope = createRequestScope(c.env);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      let meta = { labels: [], assignees: [], reviewers: [] } as { labels: unknown[]; assignees: unknown[]; reviewers: unknown[] };
      try {
        meta = await scope.get(Tokens.CollaborationService).getPullMeta(pull.id);
      } catch {
        // legacy DB without collab tables
      }
      return c.json({ pull, ...meta });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  for (const kind of ['labels', 'assignees', 'milestone'] as const) {
    app.put(`/user/repos/:owner/:repo/pulls/:number/${kind}`, async (c) => {
      const email = c.get('AuthenticatedUserEmailAddress');
      const owner = c.req.param('owner');
      const repoName = RepoService.normalizeRepo(c.req.param('repo'));
      const row = await requireVisibleRepo(c.env, owner, repoName, email);
      if (!row) return jsonError(c, 'Not found', 404);
      if (!(await needWrite(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
      const number = parseNumber(c.req.param('number'));
      if (number === null) return jsonError(c, 'Not found', 404);
      const { malformed, body } = await readJsonBody<{ labelIds?: string[]; assignees?: string[]; milestoneId?: string | null }>(c);
      if (malformed) return jsonError(c, 'Invalid JSON body', 400);
      try {
        const scope = createRequestScope(c.env);
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
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const scope = createRequestScope(c.env);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      const reviewers = await scope
        .get(Tokens.CollaborationService)
        .listReviewers(pull.id)
        .catch(() => []);
      return c.json({ reviewers });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/pulls/:number/reviewers', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{ reviewers?: string[] }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = createRequestScope(c.env);
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
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const scope = createRequestScope(c.env);
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
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{ isDraft?: boolean }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.isDraft !== 'boolean') return jsonError(c, 'isDraft must be a boolean', 400);
    try {
      const pull = await createRequestScope(c.env).get(Tokens.PullRequestService).setDraft(row.id, number, body.isDraft);
      return c.json({ pull });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update draft'), toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/pulls/:number/codeowners', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const scope = createRequestScope(c.env);
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
