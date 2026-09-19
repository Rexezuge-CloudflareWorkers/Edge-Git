import { getRepoStub } from '../repoStub';
import { jsonError, requireVisibleRepo, toSafeErrorMessage, toServiceStatus } from './PublicViewerResolver';
import { recordAndNotify } from './SocialEmit';
import { triggerRequiredChecks } from './TriggerChecks';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { PullRequestService } from '@edge-git/backend-services/pull';
import { RepoService } from '@edge-git/backend-services/repo';
import { ensureHeadObjects, getCrossRepoPreview, isPackLimitError, resolveHeadRepo } from './CrossFork';
import { openCrossForkPull } from './PullMergeRoutes';
import { parsePullNumber } from './PullShared';
import type { MergePreviewShape, PullApp } from './PullShared';
import { resolveCodeownerEmails, suggestCodeownerHandles } from './CodeownerHelpers';
import { readJsonBody } from './BodyParser';

function registerUserPullRoutes(app: PullApp): void {
  app.get('/user/repos/:owner/:repo/pulls', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return jsonError(c, 'Not found', 404);
    const scope = createRequestScope(c.env);
    const q = (c.req.query('q') ?? '').trim();
    let pulls = q
      ? await scope
          .get(Tokens.SearchService)
          .searchPulls(q, c.get('AuthenticatedUserEmailAddress'), { limit: 50, repoId: row.id })
          .catch(() => null)
      : null;
    if (!pulls) pulls = await scope.get(Tokens.PullRequestService).listByRepo(row.id, 50);
    const label = c.req.query('label');
    if (!label) return c.json({ pulls });
    try {
      const collab = scope.get(Tokens.CollaborationService);
      const filtered = [];
      for (const pull of pulls) {
        const meta = await collab.getPullMeta(pull.id).catch(() => ({ labels: [] }));
        if ((meta.labels as Array<{ name: string }>).some((l) => l.name.toLowerCase() === label.toLowerCase())) filtered.push(pull);
      }
      return c.json({ pulls: filtered });
    } catch {
      return c.json({ pulls });
    }
  });

  // Open a PR: any visible user (read+) may propose. Branches are resolved
  // via the RepoWorker DO so stored oids reflect git truth at creation time.
  // Cross-fork PRs pass headOwner/headRepo (the fork); the head must also be
  // visible to the opener, and head objects are materialized into the base DO.
  app.post('/user/repos/:owner/:repo/pulls', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{
      title?: string;
      body?: string;
      baseBranch?: string;
      headBranch?: string;
      headOwner?: string;
      headRepo?: string;
      isDraft?: boolean;
    }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (!body.title?.trim()) return jsonError(c, 'title is required', 400);
    if (!body.baseBranch?.trim() || !body.headBranch?.trim()) return jsonError(c, 'baseBranch and headBranch are required', 400);
    if (!PullRequestService.isValidBranchName(body.baseBranch.trim()) || !PullRequestService.isValidBranchName(body.headBranch.trim())) {
      return jsonError(c, 'invalid branch name', 400);
    }
    const headOwnerRaw = body.headOwner?.trim() || '';
    const headRepoRaw = body.headRepo ? RepoService.normalizeRepo(body.headRepo).trim() : '';
    if ((headOwnerRaw === '') !== (headRepoRaw === '')) return jsonError(c, 'headOwner and headRepo must be provided together', 400);
    const fullName = `${owner}/${repoName}`;
    const baseBranch = body.baseBranch.trim();
    const headBranch = body.headBranch.trim();
    const sameRepo = headOwnerRaw === '' || `${headOwnerRaw}/${headRepoRaw}`.toLowerCase() === fullName.toLowerCase();
    if (sameRepo && baseBranch === headBranch) return jsonError(c, 'baseBranch and headBranch must differ', 400);
    if (!sameRepo) {
      const result = await openCrossForkPull(c.env, {
        email,
        rowId: row.id,
        fullName,
        baseBranch,
        headBranch,
        headOwner: headOwnerRaw,
        headRepo: headRepoRaw,
        title: body.title,
        body: body.body ?? null,
      });
      return c.json(result.body, result.status);
    }
    let preview: MergePreviewShape | null = null;
    try {
      preview = (await getRepoStub(c.env, fullName).getMergePreview({
        baseRef: `refs/heads/${baseBranch}`,
        headRef: `refs/heads/${headBranch}`,
      })) as MergePreviewShape | null;
    } catch {
      preview = null;
    }
    if (!preview?.baseOid || !preview?.headOid) return jsonError(c, 'base or head branch not found', 400);
    try {
      const scope = createRequestScope(c.env);
      const created = await scope.get(Tokens.PullRequestService).createPull({
        repositoryId: row.id,
        fullName,
        title: body.title,
        body: body.body ?? null,
        baseBranch,
        headBranch,
        baseOid: preview.baseOid,
        headOid: preview.headOid,
        mergeBaseOid: preview.mergeBase ?? null,
        creatorEmail: email,
        isDraft: body.isDraft === true,
      });
      // CODEOWNERS auto-request: best-effort reviewer seeding from the
      // owners of the changed paths; never fails PR creation.
      try {
        const suggested = await suggestCodeownerHandles(c.env, fullName, {
          baseBranch,
          baseOid: preview.baseOid,
          headOid: preview.headOid,
        });
        const ownerEmails = await resolveCodeownerEmails(c.env, suggested.owners, email);
        if (ownerEmails.length > 0) {
          await scope.get(Tokens.CollaborationService).requestReviewers(created.id, ownerEmails);
        }
      } catch {
        // best-effort codeowner auto-request
      }
      await recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName,
        actorEmail: email,
        type: 'pr_opened',
        title: `Pull request #${created.number} ${body.title}`,
        subjectType: 'pull',
        subjectNumber: created.number,
        subjectOid: preview.headOid,
        mentionText: `${body.title}\n${body.body ?? ''}`,
      });
      // CI: queue required checks for the base branch against the head SHA.
      await triggerRequiredChecks(c.env, {
        repositoryId: row.id,
        fullName,
        branch: baseBranch,
        headSha: preview.headOid,
        actorEmail: email,
      }).catch(() => undefined);
      return c.json(created, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create pull request'), toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/pulls/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const pull = await createRequestScope(c.env).get(Tokens.PullRequestService).getByNumber(row.id, number);
      return c.json({ pull });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  // Triage (close/reopen): write+ only, mirrors issue triage.
  app.patch('/user/repos/:owner/:repo/pulls/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return jsonError(c, 'Forbidden', 403);
    }
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{ status?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const pull = await createRequestScope(c.env)
        .get(Tokens.PullRequestService)
        .updateStatus({ repositoryId: row.id, number, status: body.status ?? '' });
      await recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName: `${owner}/${repoName}`,
        actorEmail: email,
        type: 'pr_closed',
        title: `Pull request #${pull.number} closed: ${pull.title}`,
        subjectType: 'pull',
        subjectNumber: pull.number,
        participantEmails: [pull.creator_email],
      });
      return c.json({ pull });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update pull request'), toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/pulls/:number/comments', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const comments = await createRequestScope(c.env).get(Tokens.PullRequestService).listComments(row.id, number);
      return c.json({ comments });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/pulls/:number/comments', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{ body?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.body !== 'string' || !body.body.trim()) return jsonError(c, 'body is required', 400);
    try {
      const scope = createRequestScope(c.env);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      const comment = await scope.get(Tokens.PullRequestService).addComment({
        repositoryId: row.id,
        number,
        authorEmail: email,
        body: body.body,
      });
      await recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName: `${owner}/${repoName}`,
        actorEmail: email,
        type: 'pr_commented',
        title: `New comment on pull request #${pull.number}: ${pull.title}`,
        subjectType: 'pull',
        subjectNumber: pull.number,
        participantEmails: [pull.creator_email],
        mentionText: body.body,
      });
      return c.json({ comment }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to add comment'), toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/pulls/:number/reviews', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const reviews = await createRequestScope(c.env).get(Tokens.PullRequestService).listReviews(row.id, number);
      return c.json({ reviews });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/pulls/:number/reviews', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    const { malformed, body } = await readJsonBody<{ state?: string; body?: string; commitOid?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.state !== 'string') return jsonError(c, 'state is required', 400);
    try {
      const scope = createRequestScope(c.env);
      const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
      const review = await scope.get(Tokens.PullRequestService).addReview({
        repositoryId: row.id,
        number,
        authorEmail: email,
        state: body.state,
        body: body.body ?? null,
        commitOid: body.commitOid ?? null,
      });
      try {
        const status = body.state === 'approved' ? 'approved' : body.state === 'changes_requested' ? 'changes_requested' : 'pending';
        await scope
          .get(Tokens.CollaborationService)
          .syncReviewerStatus(pull.id, email, status)
          .catch(() => undefined);
      } catch {
        // best-effort reviewer status sync
      }
      await recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName: `${owner}/${repoName}`,
        actorEmail: email,
        type: 'pr_reviewed',
        title: `${email} reviewed pull request #${pull.number}: ${body.state}`,
        subjectType: 'pull',
        subjectNumber: pull.number,
        participantEmails: [pull.creator_email],
        mentionText: typeof body.body === 'string' ? body.body : null,
      });
      return c.json({ review }, 201);
    } catch (error) {
      const status = toServiceStatus(error);
      return jsonError(c, toSafeErrorMessage(error, 'Failed to add review'), status === 500 ? 400 : status);
    }
  });

  app.get('/user/repos/:owner/:repo/pulls/:number/diff', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const pull = await createRequestScope(c.env).get(Tokens.PullRequestService).getByNumber(row.id, number);
      if (!pull.head_oid) return jsonError(c, 'Pull request has no head commit', 400);
      const fullName = `${owner}/${repoName}`;
      const head = await resolveHeadRepo(c.env, pull);
      if (head) {
        const headRole = await createRequestScope(c.env)
          .get(Tokens.PermissionService)
          .getRole(email, head.row)
          .catch(() => null);
        if (!headRole) return jsonError(c, 'Not found', 404);
        try {
          await ensureHeadObjects(c.env, fullName, head.fullName, pull.head_oid);
        } catch (error) {
          if (isPackLimitError(error)) return jsonError(c, error instanceof Error ? error.message : 'Repository too large', 413);
          return jsonError(c, 'head commit not found', 400);
        }
      }
      const diff = await getRepoStub(c.env, fullName).getPullDiff({ baseOid: pull.base_oid, headOid: pull.head_oid });
      return c.json({ diff });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/pulls/:number/preview', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const pull = await createRequestScope(c.env).get(Tokens.PullRequestService).getByNumber(row.id, number);
      const fullName = `${owner}/${repoName}`;
      const head = await resolveHeadRepo(c.env, pull);
      if (head) {
        const headRole = await createRequestScope(c.env)
          .get(Tokens.PermissionService)
          .getRole(email, head.row)
          .catch(() => null);
        if (!headRole) return jsonError(c, 'Not found', 404);
        try {
          const { preview } = await getCrossRepoPreview(c.env, fullName, pull.base_branch, head.fullName, pull.head_branch);
          return c.json({ preview });
        } catch (error) {
          if (isPackLimitError(error)) return jsonError(c, error instanceof Error ? error.message : 'Repository too large', 413);
          return c.json({ preview: null });
        }
      }
      const preview = (await getRepoStub(c.env, fullName).getMergePreview({
        baseRef: `refs/heads/${pull.base_branch}`,
        headRef: `refs/heads/${pull.head_branch}`,
      })) as MergePreviewShape | null;
      return c.json({ preview });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });
}

export { registerUserPullRoutes };
