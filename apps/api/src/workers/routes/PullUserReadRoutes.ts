import { getRepoStub } from '../repoStub';
import { jsonError, requireVisibleRepo, toSafeErrorMessage, toServiceStatus } from './PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { ensureHeadObjects, getCrossRepoPreview, isPackLimitError, resolveHeadRepo } from './CrossFork';
import { parsePullNumber } from './PullShared';
import type { MergePreviewShape, PullApp } from './PullShared';

function registerUserPullReadRoutes(app: PullApp): void {
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

export { registerUserPullReadRoutes };
