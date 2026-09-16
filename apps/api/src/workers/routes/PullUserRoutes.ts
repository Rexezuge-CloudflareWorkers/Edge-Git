import { getRepoStub } from '../repoStub';
import { requireVisibleRepo, toServiceStatus } from './PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { PullRequestService } from '@edge-git/backend-services/pull';
import { RepoService } from '@edge-git/backend-services/repo';
import { ensureHeadObjects, getCrossRepoPreview, isPackLimitError, resolveHeadRepo } from './CrossFork';
import { openCrossForkPull } from './PullMergeRoutes';
import { parsePullNumber } from './PullShared';
import type { MergePreviewShape, PullApp } from './PullShared';

function registerUserPullRoutes(app: PullApp): void {
  app.get('/user/repos/:owner/:repo/pulls', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    const pulls = await createRequestScope(c.env).get(Tokens.PullRequestService).listByRepo(row.id, 50);
    return c.json({ pulls });
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
    if (!row) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; body?: string; baseBranch?: string; headBranch?: string; headOwner?: string; headRepo?: string };
    if (!body.title?.trim()) return c.json({ error: 'title is required' }, 400);
    if (!body.baseBranch?.trim() || !body.headBranch?.trim()) return c.json({ error: 'baseBranch and headBranch are required' }, 400);
    if (!PullRequestService.isValidBranchName(body.baseBranch.trim()) || !PullRequestService.isValidBranchName(body.headBranch.trim())) {
      return c.json({ error: 'invalid branch name' }, 400);
    }
    const headOwnerRaw = body.headOwner?.trim() || '';
    const headRepoRaw = body.headRepo ? RepoService.normalizeRepo(body.headRepo).trim() : '';
    if ((headOwnerRaw === '') !== (headRepoRaw === '')) return c.json({ error: 'headOwner and headRepo must be provided together' }, 400);
    const fullName = `${owner}/${repoName}`;
    const baseBranch = body.baseBranch.trim();
    const headBranch = body.headBranch.trim();
    const sameRepo = headOwnerRaw === '' || `${headOwnerRaw}/${headRepoRaw}`.toLowerCase() === fullName.toLowerCase();
    if (sameRepo && baseBranch === headBranch) return c.json({ error: 'baseBranch and headBranch must differ' }, 400);
    if (!sameRepo) {
      const result = await openCrossForkPull(c.env, { email, rowId: row.id, fullName, baseBranch, headBranch, headOwner: headOwnerRaw, headRepo: headRepoRaw, title: body.title, body: body.body ?? null });
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
    if (!preview?.baseOid || !preview?.headOid) return c.json({ error: 'base or head branch not found' }, 400);
    try {
      const created = await createRequestScope(c.env)
        .get(Tokens.PullRequestService)
        .createPull({
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
        });
      return c.json(created, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to create pull request' }, toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/pulls/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    try {
      const pull = await createRequestScope(c.env).get(Tokens.PullRequestService).getByNumber(row.id, number);
      return c.json({ pull });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  // Triage (close/reopen): write+ only, mirrors issue triage.
  app.patch('/user/repos/:owner/:repo/pulls/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    try {
      const pull = await createRequestScope(c.env)
        .get(Tokens.PullRequestService)
        .updateStatus({ repositoryId: row.id, number, status: body.status ?? '' });
      return c.json({ pull });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to update pull request' }, toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/pulls/:number/comments', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    try {
      const comments = await createRequestScope(c.env).get(Tokens.PullRequestService).listComments(row.id, number);
      return c.json({ comments });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/pulls/:number/comments', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { body?: string };
    if (typeof body.body !== 'string' || !body.body.trim()) return c.json({ error: 'body is required' }, 400);
    try {
      const comment = await createRequestScope(c.env).get(Tokens.PullRequestService).addComment({
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

  app.get('/user/repos/:owner/:repo/pulls/:number/reviews', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    try {
      const reviews = await createRequestScope(c.env).get(Tokens.PullRequestService).listReviews(row.id, number);
      return c.json({ reviews });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/pulls/:number/reviews', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { state?: string; body?: string; commitOid?: string };
    if (typeof body.state !== 'string') return c.json({ error: 'state is required' }, 400);
    try {
      const review = await createRequestScope(c.env).get(Tokens.PullRequestService).addReview({
        repositoryId: row.id,
        number,
        authorEmail: email,
        state: body.state,
        body: body.body ?? null,
        commitOid: body.commitOid ?? null,
      });
      return c.json({ review }, 201);
    } catch (error) {
      const status = toServiceStatus(error);
      return c.json({ error: error instanceof Error ? error.message : 'Failed to add review' }, status === 500 ? 400 : status);
    }
  });

  app.get('/user/repos/:owner/:repo/pulls/:number/diff', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    try {
      const pull = await createRequestScope(c.env).get(Tokens.PullRequestService).getByNumber(row.id, number);
      if (!pull.head_oid) return c.json({ error: 'Pull request has no head commit' }, 400);
      const fullName = `${owner}/${repoName}`;
      const head = await resolveHeadRepo(c.env, pull);
      if (head) {
        const headRole = await createRequestScope(c.env).get(Tokens.PermissionService).getRole(email, head.row).catch(() => null);
        if (!headRole) return c.json({ error: 'Not found' }, 404);
        try {
          await ensureHeadObjects(c.env, fullName, head.fullName, pull.head_oid);
        } catch (error) {
          if (isPackLimitError(error)) return c.json({ error: error instanceof Error ? error.message : 'Repository too large' }, 413);
          return c.json({ error: 'head commit not found' }, 400);
        }
      }
      const diff = await getRepoStub(c.env, fullName).getPullDiff({ baseOid: pull.base_oid, headOid: pull.head_oid });
      return c.json({ diff });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/pulls/:number/preview', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    try {
      const pull = await createRequestScope(c.env).get(Tokens.PullRequestService).getByNumber(row.id, number);
      const fullName = `${owner}/${repoName}`;
      const head = await resolveHeadRepo(c.env, pull);
      if (head) {
        const headRole = await createRequestScope(c.env).get(Tokens.PermissionService).getRole(email, head.row).catch(() => null);
        if (!headRole) return c.json({ error: 'Not found' }, 404);
        try {
          const { preview } = await getCrossRepoPreview(c.env, fullName, pull.base_branch, head.fullName, pull.head_branch);
          return c.json({ preview });
        } catch (error) {
          if (isPackLimitError(error)) return c.json({ error: error instanceof Error ? error.message : 'Repository too large' }, 413);
          return c.json({ preview: null });
        }
      }
      const preview = (await getRepoStub(c.env, fullName).getMergePreview({
        baseRef: `refs/heads/${pull.base_branch}`,
        headRef: `refs/heads/${pull.head_branch}`,
      })) as MergePreviewShape | null;
      return c.json({ preview });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });


}

export { registerUserPullRoutes };
