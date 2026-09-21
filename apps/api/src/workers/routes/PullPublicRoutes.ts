import { getRepoStub } from '../doStubs';
import { jsonError, resolvePublicViewer, toSafeErrorMessage, toServiceStatus, withPublicRepo } from './PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { ensureHeadObjects, getCrossRepoPreview, isPackLimitError, resolveHeadRepo } from './CrossFork';
import { parsePullNumber } from './PullShared';
import { presentMany, presentSingle } from './IdentityPresenter';
import type { MergePreviewShape, PullApp } from './PullShared';

function registerPullRoutes(app: PullApp): void {
  app.get('/repos/:owner/:repo/pulls', async (c) => {
    return withPublicRepo(c, async (row) => {
      const scope = createRequestScope(c.env);
      const label = c.req.query('label');
      const q = (c.req.query('q') ?? '').trim();
      let pulls = q
        ? await scope
            .get(Tokens.SearchService)
            .searchPulls(q, await resolvePublicViewer(c).catch(() => null), { limit: 50, repoId: row.id })
            .catch(() => null)
        : null;
      if (!pulls) pulls = await scope.get(Tokens.PullRequestService).listByRepo(row.id, 50);
      if (!label) return c.json({ pulls: await presentMany(scope, pulls) });
      try {
        const collab = scope.get(Tokens.CollaborationService);
        const filtered = [];
        for (const pull of pulls) {
          const meta = await collab.getPullMeta(pull.id).catch(() => ({ labels: [] }));
          if ((meta.labels as Array<{ name: string }>).some((l) => l.name.toLowerCase() === label.toLowerCase())) filtered.push(pull);
        }
        return c.json({ pulls: await presentMany(scope, filtered) });
      } catch {
        return c.json({ pulls: await presentMany(scope, pulls) });
      }
    });
  });

  app.get('/repos/:owner/:repo/pulls/:number', async (c) => {
    return withPublicRepo(c, async (row) => {
      const number = parsePullNumber(c.req.param('number'));
      if (number === null) return jsonError(c, 'Not found', 404);
      try {
        const scope = createRequestScope(c.env);
        const pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
        return c.json({ pull: await presentSingle(scope, pull) });
      } catch (error) {
        return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
      }
    });
  });

  app.get('/repos/:owner/:repo/pulls/:number/comments', async (c) => {
    return withPublicRepo(c, async (row) => {
      const number = parsePullNumber(c.req.param('number'));
      if (number === null) return jsonError(c, 'Not found', 404);
      try {
        const scope = createRequestScope(c.env);
        const comments = await scope.get(Tokens.PullRequestService).listComments(row.id, number);
        return c.json({ comments: await presentMany(scope, comments) });
      } catch (error) {
        return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
      }
    });
  });

  app.get('/repos/:owner/:repo/pulls/:number/reviews', async (c) => {
    return withPublicRepo(c, async (row) => {
      const number = parsePullNumber(c.req.param('number'));
      if (number === null) return jsonError(c, 'Not found', 404);
      try {
        const scope = createRequestScope(c.env);
        const reviews = await scope.get(Tokens.PullRequestService).listReviews(row.id, number);
        return c.json({ reviews: await presentMany(scope, reviews) });
      } catch (error) {
        return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
      }
    });
  });

  app.get('/repos/:owner/:repo/pulls/:number/diff', async (c) => {
    return withPublicRepo(c, async (row, fullName) => {
      const number = parsePullNumber(c.req.param('number'));
      if (number === null) return jsonError(c, 'Not found', 404);
      try {
        const pull = await createRequestScope(c.env).get(Tokens.PullRequestService).getByNumber(row.id, number);
        if (!pull.head_oid) return jsonError(c, 'Pull request has no head commit', 400);
        const head = await resolveHeadRepo(c.env, pull);
        if (head) {
          // A private fork's diff must not leak through a public base repo.
          const viewerEmail = await resolvePublicViewer(c);
          const headRole = await createRequestScope(c.env)
            .get(Tokens.PermissionService)
            .getRole(viewerEmail, head.row)
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
  });

  app.get('/repos/:owner/:repo/pulls/:number/preview', async (c) => {
    return withPublicRepo(c, async (row, fullName) => {
      const number = parsePullNumber(c.req.param('number'));
      if (number === null) return jsonError(c, 'Not found', 404);
      try {
        const pull = await createRequestScope(c.env).get(Tokens.PullRequestService).getByNumber(row.id, number);
        const head = await resolveHeadRepo(c.env, pull);
        if (head) {
          const viewerEmail = await resolvePublicViewer(c);
          const headRole = await createRequestScope(c.env)
            .get(Tokens.PermissionService)
            .getRole(viewerEmail, head.row)
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
  });
}

export { registerPullRoutes };
