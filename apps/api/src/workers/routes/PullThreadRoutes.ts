import { jsonError, requireVisibleRepo, toSafeErrorMessage, toServiceStatus, withPublicRepo, getScope } from './PublicViewerResolver';
import { recordAndNotify } from './SocialEmit';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import { parsePullNumber } from './PullShared';
import type { PullApp } from './PullShared';
import { readJsonBody } from './BodyParser';
import { presentMany, presentSingle } from './IdentityPresenter';

type RequestScope = ReturnType<typeof createRequestScope>;

// Threads carry nested `comments[]` with their own `author_email`s; `presentOne`
// already recurses, but keep the explicit pass for legacy rows.
async function presentThreads(scope: RequestScope, threads: unknown[]): Promise<Array<Record<string, unknown>>> {
  const presented = await presentMany(scope, threads);
  return presented;
}

function registerPullThreadRoutes(app: PullApp): void {
  app.get('/repos/:owner/:repo/pulls/:number/threads', async (c) => {
    return withPublicRepo(c, async (row) => {
      const number = parsePullNumber(c.req.param('number'));
      if (number === null) return jsonError(c, 'Not found', 404);
      try {
        const scope = getScope(c);
        const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
        const threads = await scope.get(Tokens.PullThreadService).listThreads(pull.id);
        return c.json({ threads: await presentThreads(scope, threads as unknown[]) });
      } catch (error) {
        return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
      }
    });
  });
}

function registerUserPullThreadRoutes(app: PullApp): void {
  app.get('/user/repos/:owner/:repo/pulls/:number/threads', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const scope = getScope(c);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      const threads = await scope.get(Tokens.PullThreadService).listThreads(pull.id);
      return c.json({ threads: await presentThreads(scope, threads as unknown[]) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  // Open an inline thread: any visible user may comment (mirrors PR comments).
  app.post('/user/repos/:owner/:repo/pulls/:number/threads', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{
      path?: string;
      line?: number | null;
      side?: string | null;
      commitOid?: string | null;
      body?: string;
    }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      const thread = await scope.get(Tokens.PullThreadService).openThread({
        pullRequestId: pull.id,
        authorEmail: email,
        path: body.path ?? '',
        line: body.line,
        side: body.side,
        commitOid: body.commitOid,
        body: body.body ?? '',
      });
      await recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName: `${owner}/${repoName}`,
        actorEmail: email,
        type: 'pr_commented',
        title: `New inline comment on pull request #${pull.number}: ${pull.title}`,
        subjectType: 'pull',
        subjectNumber: pull.number,
        participantEmails: [pull.creator_email],
        mentionText: body.body ?? null,
      });
      const [presented] = await presentThreads(scope, [thread]);
      return c.json({ thread: presented }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to open thread'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/pulls/:number/threads/:threadId/replies', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{ body?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      const comment = await scope.get(Tokens.PullThreadService).replyThread({
        pullRequestId: pull.id,
        threadId: c.req.param('threadId'),
        authorEmail: email,
        body: body.body ?? '',
      });
      await recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName: `${owner}/${repoName}`,
        actorEmail: email,
        type: 'pr_commented',
        title: `New reply on pull request #${pull.number}: ${pull.title}`,
        subjectType: 'pull',
        subjectNumber: pull.number,
        participantEmails: [pull.creator_email],
        mentionText: body.body ?? null,
      });
      return c.json({ comment: await presentSingle(scope, comment) }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to reply'), toServiceStatus(error));
    }
  });

  // Resolve/reopen: thread author or write+ (mirrors triage permissions).
  app.patch('/user/repos/:owner/:repo/pulls/:number/threads/:threadId', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{ resolved?: boolean }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.resolved !== 'boolean') return jsonError(c, 'resolved must be a boolean', 400);
    try {
      const scope = getScope(c);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      const threads = await scope.get(Tokens.PullThreadService).listThreads(pull.id);
      const thread = threads.find((t) => t.id === c.req.param('threadId'));
      if (!thread) return jsonError(c, 'Not found', 404);
      if (thread.author_email.toLowerCase() !== email.toLowerCase()) {
        try {
          await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
        } catch {
          return jsonError(c, 'Forbidden', 403);
        }
      }
      const updated = await scope.get(Tokens.PullThreadService).resolveThread({
        pullRequestId: pull.id,
        threadId: thread.id,
        resolvedBy: email,
        resolved: body.resolved,
      });
      return c.json({ thread: await presentSingle(scope, updated) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update thread'), toServiceStatus(error));
    }
  });

  // Dismiss a review: write+ only (mirrors triage). Dismissed reviews stay
  // visible but no longer block the merge or count toward the quorum.
  app.post('/user/repos/:owner/:repo/pulls/:number/reviews/:reviewId/dismiss', async (c) => {
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
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{ reason?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
      const review = await scope.get(Tokens.PullRequestService).dismissReview({
        repositoryId: row.id,
        number,
        reviewId: c.req.param('reviewId'),
        dismissedBy: email,
        reason: body.reason ?? null,
      });
      try {
        await scope
          .get(Tokens.CollaborationService)
          .syncReviewerStatus(review.pull_request_id, review.author_email, 'pending')
          .catch(() => undefined);
      } catch {
        // best-effort reviewer status reset
      }
      return c.json({ review: await presentSingle(scope, review) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to dismiss review'), toServiceStatus(error));
    }
  });
}

export { registerPullThreadRoutes, registerUserPullThreadRoutes };
