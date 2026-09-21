import type { Hono } from 'hono';
import { getRepoStub } from '../doStubs';
import { jsonError, withVisibleRepo } from './PublicViewerResolver';
import { RepoFullName } from '@edge-git/shared/utils';
import type { RequestContext } from '@/middleware';
import {
  parseOverviewArgs,
  parseWithLastCommit,
  sanitizeDepthParam,
  sanitizePathParam,
  sanitizeRefParam,
} from './RepoParamParsers';

type RepoApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

async function withVisibleRepoLocal(
  c: RequestContext,
  owner: string,
  repoName: string,
  fn: (fullName: string) => Promise<Response>,
): Promise<Response> {
  return withVisibleRepo(c, owner, repoName, async (_row, fullName) => fn(fullName));
}

// Authed read-model passthroughs (branches/tree/blob/commits/overview) via
// DO RPC. Extracted from `RepoRoutes` (god-file guard); the public twins
// live in `registerRepoRoutes`.
function registerUserRepoReadModelRoutes(app: RepoApp): void {
  app.get('/user/repos/:owner/:repo/branches', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) => c.json(await getRepoStub(c.env, fullName).getBranches()));
  });

  app.get('/user/repos/:owner/:repo/tags', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) => c.json(await getRepoStub(c.env, fullName).getTags()));
  });

  app.get('/user/repos/:owner/:repo/tree', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const url = new URL(c.req.url);
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) =>
      c.json(
        await getRepoStub(c.env, fullName).getTree({
          ref: sanitizeRefParam(url.searchParams.get('ref')),
          path: sanitizePathParam(url.searchParams.get('path')),
          withLastCommit: parseWithLastCommit(url.searchParams.get('withLastCommit')),
        }),
      ),
    );
  });

  app.get('/user/repos/:owner/:repo/blob', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const url = new URL(c.req.url);
    const filepath = sanitizePathParam(url.searchParams.get('path')) ?? '';
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) =>
      c.json(await getRepoStub(c.env, fullName).getBlob({ ref: sanitizeRefParam(url.searchParams.get('ref')), filepath })),
    );
  });

  app.get('/user/repos/:owner/:repo/commits', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const url = new URL(c.req.url);
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) =>
      c.json(
        await getRepoStub(c.env, fullName).getCommits({
          ref: sanitizeRefParam(url.searchParams.get('ref')),
          depth: sanitizeDepthParam(url.searchParams.get('depth')),
        }),
      ),
    );
  });

  app.get('/user/repos/:owner/:repo/commits/:oid', async (c) => {
    const oid = c.req.param('oid');
    if (!/^[0-9a-f]{40}$/i.test(oid)) return jsonError(c, 'Invalid commit oid', 400);
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) => {
      const diff = (await getRepoStub(c.env, fullName).getCommitDiff(oid)) as { commit: unknown } | null;
      if (!diff || !diff.commit) return jsonError(c, 'Not found', 404);
      return c.json(diff);
    });
  });

  app.get('/user/repos/:owner/:repo/compare', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const url = new URL(c.req.url);
    const baseRef = sanitizeRefParam(url.searchParams.get('base')) ?? '';
    const headRef = sanitizeRefParam(url.searchParams.get('head')) ?? '';
    if (!baseRef || !headRef) return jsonError(c, 'base and head query params are required', 400);
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) => {
      const diff = await getRepoStub(c.env, fullName).getCompare({ baseRef, headRef });
      if (!diff) return jsonError(c, 'Not found', 404);
      return c.json(diff);
    });
  });

  app.get('/user/repos/:owner/:repo/overview', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const url = new URL(c.req.url);
    const args = parseOverviewArgs(url.searchParams);
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) =>
      c.json(await getRepoStub(c.env, fullName).getOverview(args)),
    );
  });
}

export { registerUserRepoReadModelRoutes };
