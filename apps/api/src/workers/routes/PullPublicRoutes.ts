import { getRepoStub } from '../repoStub';
import { toServiceStatus, withPublicRepo } from './PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { parsePullNumber } from './PullShared';
import type { MergePreviewShape, PullApp } from './PullShared';

function registerPullRoutes(app: PullApp): void {
  app.get('/repos/:owner/:repo/pulls', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      const pulls = await createRequestScope(c.env).get(Tokens.PullRequestService).listByRepo(row.id, 50);
      return c.json({ pulls });
    });
  });

  app.get('/repos/:owner/:repo/pulls/:number', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      const number = parsePullNumber(c.req.param('number'));
      if (number === null) return c.json({ error: 'Not found' }, 404);
      try {
        const pull = await createRequestScope(c.env).get(Tokens.PullRequestService).getByNumber(row.id, number);
        return c.json({ pull });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
      }
    });
  });

  app.get('/repos/:owner/:repo/pulls/:number/comments', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      const number = parsePullNumber(c.req.param('number'));
      if (number === null) return c.json({ error: 'Not found' }, 404);
      try {
        const comments = await createRequestScope(c.env).get(Tokens.PullRequestService).listComments(row.id, number);
        return c.json({ comments });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
      }
    });
  });

  app.get('/repos/:owner/:repo/pulls/:number/reviews', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      const number = parsePullNumber(c.req.param('number'));
      if (number === null) return c.json({ error: 'Not found' }, 404);
      try {
        const reviews = await createRequestScope(c.env).get(Tokens.PullRequestService).listReviews(row.id, number);
        return c.json({ reviews });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
      }
    });
  });

  app.get('/repos/:owner/:repo/pulls/:number/diff', async (c) => {
    return withPublicRepo(c as never, async (row, fullName) => {
      const number = parsePullNumber(c.req.param('number'));
      if (number === null) return c.json({ error: 'Not found' }, 404);
      try {
        const pull = await createRequestScope(c.env).get(Tokens.PullRequestService).getByNumber(row.id, number);
        if (!pull.head_oid) return c.json({ error: 'Pull request has no head commit' }, 400);
        const diff = await getRepoStub(c.env, fullName).getPullDiff({ baseOid: pull.base_oid, headOid: pull.head_oid });
        return c.json({ diff });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
      }
    });
  });

  app.get('/repos/:owner/:repo/pulls/:number/preview', async (c) => {
    return withPublicRepo(c as never, async (row, fullName) => {
      const number = parsePullNumber(c.req.param('number'));
      if (number === null) return c.json({ error: 'Not found' }, 404);
      try {
        const pull = await createRequestScope(c.env).get(Tokens.PullRequestService).getByNumber(row.id, number);
        const preview = (await getRepoStub(c.env, fullName).getMergePreview({
          baseRef: `refs/heads/${pull.base_branch}`,
          headRef: `refs/heads/${pull.head_branch}`,
        })) as MergePreviewShape | null;
        return c.json({ preview });
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
      }
    });
  });
}

export { registerPullRoutes };
