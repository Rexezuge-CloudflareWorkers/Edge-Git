import type { Hono } from 'hono';
import { getRepoStub } from '../doStubs';
import { getScope, jsonError, withVisibleRepo } from './PublicViewerResolver';
import { Tokens } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import type { RequestContext } from '@/middleware';
import { parseOverviewArgs, parseWithLastCommit, sanitizeDepthParam, sanitizePathParam, sanitizeRefParam } from './RepoParamParsers';
import { isFresh, serveReadModel } from './RepoReadCache';

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
// live in `registerRepoRoutes`. All mutable reads share the KV conditional
// cache in `RepoReadCache` so repeated code-page loads 304 without DO I/O.
function registerUserRepoReadModelRoutes(app: RepoApp): void {
  app.get('/user/repos/:owner/:repo/branches', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) => {
      const cache = getScope(c).get(Tokens.KvCache);
      const stub = getRepoStub(c.env, fullName);
      return serveReadModel(c, cache, fullName, 'branches', {}, () => stub.getBranches(), {
        fetchRefs: () => stub.listRefs(),
      });
    });
  });

  app.get('/user/repos/:owner/:repo/tags', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) => {
      const cache = getScope(c).get(Tokens.KvCache);
      const stub = getRepoStub(c.env, fullName);
      return serveReadModel(c, cache, fullName, 'tags', {}, () => stub.getTags(), {
        fetchRefs: () => stub.listRefs(),
      });
    });
  });

  app.get('/user/repos/:owner/:repo/tree', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const url = new URL(c.req.url);
    const args = {
      ref: sanitizeRefParam(url.searchParams.get('ref')),
      path: sanitizePathParam(url.searchParams.get('path')),
      withLastCommit: parseWithLastCommit(url.searchParams.get('withLastCommit')) ?? false,
    };
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) => {
      const cache = getScope(c).get(Tokens.KvCache);
      const stub = getRepoStub(c.env, fullName);
      return serveReadModel(c, cache, fullName, 'tree', args, () => stub.getTree(args), {
        fetchRefs: () => stub.listRefs(),
      });
    });
  });

  app.get('/user/repos/:owner/:repo/blob', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const url = new URL(c.req.url);
    const filepath = sanitizePathParam(url.searchParams.get('path')) ?? '';
    const args = { ref: sanitizeRefParam(url.searchParams.get('ref')), filepath };
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) => {
      const cache = getScope(c).get(Tokens.KvCache);
      const stub = getRepoStub(c.env, fullName);
      return serveReadModel(c, cache, fullName, 'blob', args, () => stub.getBlob(args), {
        fetchRefs: () => stub.listRefs(),
      });
    });
  });

  app.get('/user/repos/:owner/:repo/commits', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const url = new URL(c.req.url);
    const args = {
      ref: sanitizeRefParam(url.searchParams.get('ref')),
      depth: sanitizeDepthParam(url.searchParams.get('depth')),
    };
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) => {
      const cache = getScope(c).get(Tokens.KvCache);
      const stub = getRepoStub(c.env, fullName);
      return serveReadModel(c, cache, fullName, 'commits', args, () => stub.getCommits(args), {
        fetchRefs: () => stub.listRefs(),
      });
    });
  });

  app.get('/user/repos/:owner/:repo/commits/:oid', async (c) => {
    const oid = c.req.param('oid');
    if (!/^[0-9a-f]{40}$/i.test(oid)) return jsonError(c, 'Invalid commit oid', 400);
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) => {
      const etag = `W/"commit-diff-${oid.slice(0, 16).toLowerCase()}"`;
      if (isFresh(c.req.raw, etag)) return new Response(null, { status: 304, headers: { ETag: etag } });
      const diff = (await getRepoStub(c.env, fullName).getCommitDiff(oid)) as { commit: unknown } | null;
      if (!diff || !diff.commit) return jsonError(c, 'Not found', 404);
      return c.json(diff, 200, { ETag: etag, 'Cache-Control': 'private, max-age=86400, immutable' });
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
    return withVisibleRepoLocal(c, owner, repoName, async (fullName) => {
      const cache = getScope(c).get(Tokens.KvCache);
      const stub = getRepoStub(c.env, fullName);
      return serveReadModel(c, cache, fullName, 'overview', args, () => stub.getOverview(args), {
        fetchRefs: () => stub.listRefs(),
        extractHeadOid: (result) => (result as { resolvedRef?: string } | null)?.resolvedRef ?? null,
      });
    });
  });
}

export { registerUserRepoReadModelRoutes };
