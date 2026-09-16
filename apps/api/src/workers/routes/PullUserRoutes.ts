import { getRepoStub } from '../repoStub';
import { requireVisibleRepo, toServiceStatus } from './PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { PullRequestService } from '@edge-git/backend-services/pull';
import { RepoService } from '@edge-git/backend-services/repo';
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
  app.post('/user/repos/:owner/:repo/pulls', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { title?: string; body?: string; baseBranch?: string; headBranch?: string };
    if (!body.title?.trim()) return c.json({ error: 'title is required' }, 400);
    if (!body.baseBranch?.trim() || !body.headBranch?.trim()) return c.json({ error: 'baseBranch and headBranch are required' }, 400);
    if (!PullRequestService.isValidBranchName(body.baseBranch.trim()) || !PullRequestService.isValidBranchName(body.headBranch.trim())) {
      return c.json({ error: 'invalid branch name' }, 400);
    }
    const fullName = `${owner}/${repoName}`;
    let preview: MergePreviewShape | null = null;
    try {
      preview = (await getRepoStub(c.env, fullName).getMergePreview({
        baseRef: `refs/heads/${body.baseBranch.trim()}`,
        headRef: `refs/heads/${body.headBranch.trim()}`,
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
          baseBranch: body.baseBranch.trim(),
          headBranch: body.headBranch.trim(),
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
      const diff = await getRepoStub(c.env, `${owner}/${repoName}`).getPullDiff({ baseOid: pull.base_oid, headOid: pull.head_oid });
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
      const preview = (await getRepoStub(c.env, `${owner}/${repoName}`).getMergePreview({
        baseRef: `refs/heads/${pull.base_branch}`,
        headRef: `refs/heads/${pull.head_branch}`,
      })) as MergePreviewShape | null;
      return c.json({ preview });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  // Merge: write+ only. changes_requested reviews block the merge (409).
  // Conflicts from the DO also surface as 409 with the file list.
  app.post('/user/repos/:owner/:repo/pulls/:number/merge', async (c) => {
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
    const scope = createRequestScope(c.env);
    let pull;
    try {
      pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
    if (pull.status === 'merged') return c.json({ error: 'pull request is already merged' }, 400);
    if (pull.status === 'closed') return c.json({ error: 'closed pull requests cannot be merged' }, 400);
    // Fail fast on blocking reviews before touching git.
    const reviews = await scope.get(Tokens.PullRequestService).listReviews(row.id, number);
    if (PullRequestService.isBlockedByReviews(reviews)) return c.json({ error: 'pull request has unresolved change requests' }, 409);
    // Refresh oids from git truth (branches may have moved since PR creation).
    let headOid = pull.head_oid;
    try {
      const preview = (await getRepoStub(c.env, `${owner}/${repoName}`).getMergePreview({
        baseRef: `refs/heads/${pull.base_branch}`,
        headRef: `refs/heads/${pull.head_branch}`,
      })) as MergePreviewShape | null;
      if (preview?.headOid) headOid = preview.headOid;
      if (preview && (preview.baseOid || preview.headOid)) {
        try {
          await scope.get(Tokens.PullRequestService).refreshOids({
            repositoryId: row.id,
            number,
            baseOid: preview.baseOid ?? null,
            headOid: preview.headOid ?? null,
            mergeBaseOid: preview.mergeBase ?? null,
          });
        } catch {
          // Best-effort: stale stored oids must not block the merge itself.
        }
      }
    } catch {
      // fall through with stored oid
    }
    if (!headOid) return c.json({ error: 'head branch not found' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { message?: string; deleteHead?: boolean };
    const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
    const message = rawMessage ? rawMessage.slice(0, 1000) : `Merge pull request #${number}: ${pull.title}`;
    const deleteHead = body.deleteHead === true;
    let outcome: { type?: string; commitOid?: string; conflicts?: string[]; reason?: string; deletedHead?: boolean };
    try {
      outcome = (await getRepoStub(c.env, `${owner}/${repoName}`).mergePull({
        baseBranch: pull.base_branch,
        headBranch: pull.head_branch,
        headOid,
        authorName: email.split('@', 1)[0] || email,
        authorEmail: email,
        message,
        deleteHead,
      })) as { type?: string; commitOid?: string; conflicts?: string[]; reason?: string; deletedHead?: boolean };
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Merge failed' }, 500);
    }
    if (outcome.type === 'conflict') {
      return c.json({ error: 'merge conflicts', conflicts: outcome.conflicts ?? [], reason: outcome.reason ?? null }, 409);
    }
    try {
      const merged = await scope.get(Tokens.PullRequestService).markMerged({ repositoryId: row.id, number, mergedBy: email, commitOid: outcome.commitOid ?? headOid });
      return c.json({ pull: merged, merge: outcome });
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Failed to record merge';
      const status = failure.includes('unresolved change requests') ? 409 : toServiceStatus(error);
      return c.json({ error: failure }, status === 500 ? 400 : status);
    }
  });
}

export { registerUserPullRoutes };
