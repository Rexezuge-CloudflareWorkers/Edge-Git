import type { Hono } from 'hono';
import { getCheckRunnerStub, getRepoStub, ensureRepo } from '../doStubs';
import {
  getScope,
  jsonError,
  requireVisibleRepo,
  toRepoJson,
  toSafeErrorMessage,
  toServiceStatus,
  withPublicRepo,
} from './PublicViewerResolver';
import { recordAndNotify } from './SocialEmit';
import { getRepoSocial } from './RepoSocialHelper';
import { Tokens } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { EmailAddress, RepoFullName } from '@edge-git/shared/utils';
import { readJsonBody } from './BodyParser';
import { parseOverviewArgs, parseWithLastCommit, sanitizeDepthParam, sanitizePathParam, sanitizeRefParam } from './RepoParamParsers';
import { ErrorSanitizationUtil } from '@edge-git/shared/utils';
import { isFresh, serveReadModel, invalidateRepoCaches } from './RepoReadCache';

type RepoApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

export { getRepoSocial } from './RepoSocialHelper';

// Public read-model API — anonymous OK for public repos (private → 404
// unless the caller presents Access identity or a PAT for the owner).
function registerRepoRoutes(app: RepoApp): void {
  app.get('/repos/:owner/:repo', async (c) => {
    return withPublicRepo(c, async (row, _fullName, viewerEmail) => {
      const scope = getScope(c);
      const [role, forksCount, social] = await Promise.all([
        scope
          .get(Tokens.PermissionService)
          .getRole(viewerEmail, row)
          .catch(() => null),
        scope
          .get(Tokens.ForkService)
          .countForks(row.id)
          .catch(() => 0),
        getRepoSocial(scope, row.id, viewerEmail),
      ]);
      return c.json({
        ...(toRepoJson(row, role) as Record<string, unknown>),
        viewerCanManage: role === 'admin',
        viewerRole: role,
        forksCount,
        ...social,
        starred: social.viewerStarred,
        watching: social.viewerWatching,
      });
    });
  });

  app.get('/repos/:owner/:repo/branches', async (c) => {
    return withPublicRepo(c, async (_row, fullName) => {
      const cache = getScope(c).get(Tokens.KvCache);
      const stub = getRepoStub(c.env, fullName);
      return serveReadModel(c, cache, fullName, 'branches', {}, () => stub.getBranches(), {
        fetchRefs: () => stub.listRefs(),
      });
    });
  });

  app.get('/repos/:owner/:repo/tags', async (c) => {
    return withPublicRepo(c, async (_row, fullName) => {
      const cache = getScope(c).get(Tokens.KvCache);
      const stub = getRepoStub(c.env, fullName);
      return serveReadModel(c, cache, fullName, 'tags', {}, () => stub.getTags(), {
        fetchRefs: () => stub.listRefs(),
      });
    });
  });

  app.get('/repos/:owner/:repo/tree', async (c) => {
    return withPublicRepo(c, async (_row, fullName) => {
      const url = new URL(c.req.url);
      const args = {
        ref: sanitizeRefParam(url.searchParams.get('ref')),
        path: sanitizePathParam(url.searchParams.get('path')),
        withLastCommit: parseWithLastCommit(url.searchParams.get('withLastCommit')) ?? false,
      };
      const cache = getScope(c).get(Tokens.KvCache);
      const stub = getRepoStub(c.env, fullName);
      return serveReadModel(c, cache, fullName, 'tree', args, () => stub.getTree(args), {
        fetchRefs: () => stub.listRefs(),
      });
    });
  });

  app.get('/repos/:owner/:repo/blob', async (c) => {
    return withPublicRepo(c, async (_row, fullName) => {
      const url = new URL(c.req.url);
      const args = {
        ref: sanitizeRefParam(url.searchParams.get('ref')),
        filepath: sanitizePathParam(url.searchParams.get('path')) ?? '',
      };
      const cache = getScope(c).get(Tokens.KvCache);
      const stub = getRepoStub(c.env, fullName);
      return serveReadModel(c, cache, fullName, 'blob', args, () => stub.getBlob(args), {
        fetchRefs: () => stub.listRefs(),
      });
    });
  });

  app.get('/repos/:owner/:repo/commits', async (c) => {
    return withPublicRepo(c, async (_row, fullName) => {
      const url = new URL(c.req.url);
      const args = {
        ref: sanitizeRefParam(url.searchParams.get('ref')),
        depth: sanitizeDepthParam(url.searchParams.get('depth')),
      };
      const cache = getScope(c).get(Tokens.KvCache);
      const stub = getRepoStub(c.env, fullName);
      return serveReadModel(c, cache, fullName, 'commits', args, () => stub.getCommits(args), {
        fetchRefs: () => stub.listRefs(),
      });
    });
  });

  // Aggregate code-page read: branches + tags + fast tree + commits + README
  // in one DO RPC. Replaces 5 sequential granular calls on owner/repo load.
  app.get('/repos/:owner/:repo/overview', async (c) => {
    return withPublicRepo(c, async (_row, fullName) => {
      const url = new URL(c.req.url);
      const args = parseOverviewArgs(url.searchParams);
      const cache = getScope(c).get(Tokens.KvCache);
      const stub = getRepoStub(c.env, fullName);
      return serveReadModel(c, cache, fullName, 'overview', args, () => stub.getOverview(args), {
        fetchRefs: () => stub.listRefs(),
        extractHeadOid: (result) => (result as { resolvedRef?: string } | null)?.resolvedRef ?? null,
      });
    });
  });

  app.get('/repos/:owner/:repo/commits/:oid', async (c) => {
    const oid = c.req.param('oid');
    if (!/^[0-9a-f]{40}$/i.test(oid)) return jsonError(c, 'Invalid commit oid', 400);
    return withPublicRepo(c, async (_row, fullName) => {
      // Immutable by oid: 304 without DO I/O when the browser already holds it.
      const etag = `W/"commit-diff-${oid.slice(0, 16).toLowerCase()}"`;
      if (isFresh(c.req.raw, etag)) return new Response(null, { status: 304, headers: { ETag: etag } });
      const diff = (await getRepoStub(c.env, fullName).getCommitDiff(oid)) as { commit: unknown } | null;
      if (!diff || !diff.commit) return jsonError(c, 'Not found', 404);
      return c.json(diff, 200, { ETag: etag, 'Cache-Control': 'private, max-age=86400, immutable' });
    });
  });

  app.get('/repos/:owner/:repo/compare', async (c) => {
    return withPublicRepo(c, async (_row, fullName) => {
      const url = new URL(c.req.url);
      const baseRef = sanitizeRefParam(url.searchParams.get('base')) ?? '';
      const headRef = sanitizeRefParam(url.searchParams.get('head')) ?? '';
      if (!baseRef || !headRef) return jsonError(c, 'base and head query params are required', 400);
      const diff = await getRepoStub(c.env, fullName).getCompare({ baseRef, headRef });
      if (!diff) return jsonError(c, 'Not found', 404);
      return c.json(diff);
    });
  });
}

// Protected repo CRUD behind /user/* Access auth (plus /user/me identity).
function registerUserRepoRoutes(app: RepoApp): void {
  app.get('/user/me', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const profile = await getScope(c).get(Tokens.UserService).getProfileByEmail(email);
      return c.json({ email: profile.email, username: profile.username });
    } catch {
      return c.json({ email });
    }
  });

  app.get('/user/repos', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const scope = getScope(c);
    const rows = await scope.get(Tokens.RepoService).listVisibleForUser(email, 100);
    const permission = scope.get(Tokens.PermissionService);
    const repos = [];
    for (const row of rows) {
      const role = await permission.getRole(email, row).catch(() => null);
      repos.push({ ...(toRepoJson(row, role) as Record<string, unknown>), viewerCanManage: role === 'admin', viewerRole: role });
    }
    return c.json({ repos });
  });

  app.post('/user/repos', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, oversized, body } = await readJsonBody<{
      owner?: string;
      name?: string;
      description?: string | null;
      isPrivate?: boolean;
    }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    const scope = getScope(c);
    let owner = (body.owner ?? '').trim();
    if (!owner) {
      try {
        const profile = await scope.get(Tokens.UserService).getProfileByEmail(email);
        owner = (profile.username ?? EmailAddress.normalize(email).split('@', 1)[0]).trim();
      } catch {
        owner = EmailAddress.normalize(email).split('@', 1)[0]?.trim() ?? '';
      }
    }
    const name = (body.name ?? '').trim();
    if (!name) return jsonError(c, 'name is required', 400);
    try {
      RepoService.validateNames(owner, RepoFullName.normalizeRepo(name));
      const svc = scope.get(Tokens.RepoService);
      const normalized = RepoFullName.normalizeRepo(name);
      const { id } = await svc.createRepo(email, owner, normalized, body.description ?? null, body.isPrivate ?? false);
      const created = await svc.getByOwnerAndName(owner, normalized);
      const canonicalOwner = created?.owner ?? owner;
      await ensureRepo(c.env, `${canonicalOwner}/${normalized}`);
      const fullName = `${canonicalOwner}/${normalized}`;
      await scope
        .get(Tokens.WatchService)
        .ensureWatching(id, email)
        .catch(() => undefined);
      await recordAndNotify(c.env, {
        repositoryId: id,
        fullName,
        actorEmail: email,
        type: 'repo_created',
        title: `Created repository ${fullName}`,
      });
      return c.json({ id, owner: canonicalOwner, name: normalized, fullName }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create repo';
      const status =
        message.includes('already exists') || message.includes('Invalid') || message.includes('Maximum') || message.includes('reserved')
          ? 400
          : message.includes('members') || message.includes('owner')
            ? 403
            : 500;
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create repo'), status as 400);
    }
  });

  app.get('/user/repos/:owner/:repo', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const scope = getScope(c);
    const row = await requireVisibleRepo(c.env, c.req.param('owner'), RepoFullName.normalizeRepo(c.req.param('repo')), email, scope);
    if (!row) return jsonError(c, 'Not found', 404);
    const [role, forksCount, social] = await Promise.all([
      scope
        .get(Tokens.PermissionService)
        .getRole(email, row)
        .catch(() => null),
      scope
        .get(Tokens.ForkService)
        .countForks(row.id)
        .catch(() => 0),
      getRepoSocial(scope, row.id, email),
    ]);
    return c.json({
      ...(toRepoJson(row, role) as Record<string, unknown>),
      viewerCanManage: role === 'admin',
      viewerRole: role,
      forksCount,
      ...social,
      starred: social.viewerStarred,
      watching: social.viewerWatching,
    });
  });

  app.patch('/user/repos/:owner/:repo', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const { malformed, oversized, body } = await readJsonBody<{ description?: string | null; isPrivate?: boolean }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    const patch: { description?: string | null; isPrivate?: boolean } = {};
    if ('description' in body) patch.description = body.description ?? null;
    if ('isPrivate' in body) patch.isPrivate = body.isPrivate;
    if (patch.description === undefined && patch.isPrivate === undefined) {
      return jsonError(c, 'Nothing to update', 400);
    }
    try {
      const updated = await getScope(c).get(Tokens.RepoService).updateRepo(owner, repoName, email, patch);
      return c.json({ ...(toRepoJson(updated) as Record<string, unknown>), viewerCanManage: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update repo'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    try {
      const { id } = await getScope(c).get(Tokens.RepoService).deleteRepo(owner, repoName, email);
      // Purge git objects from the Durable Object (best-effort; D1 is source of truth).
      // `RepoService.deleteRepo` also enqueued a vacuum tombstone — the
      // background `RepoVacuumTask` repeats the purges below and finishes
      // with a full `storage.deleteAll()` once the name stays free.
      const fullName = `${owner}/${repoName}`;
      try {
        await getRepoStub(c.env, fullName).deleteRepo();
      } catch (error) {
        console.error('Failed to purge repo DO', fullName, ErrorSanitizationUtil.sanitizeErrorForLogging(error));
      }
      try {
        await getCheckRunnerStub(c.env, fullName).purgeRepo(id);
      } catch (error) {
        console.error('Failed to purge check queue', fullName, ErrorSanitizationUtil.sanitizeErrorForLogging(error));
      }
      try {
        await invalidateRepoCaches(getScope(c).get(Tokens.KvCache), fullName);
      } catch (error) {
        console.error('Failed to purge repo caches', fullName, ErrorSanitizationUtil.sanitizeErrorForLogging(error));
      }
      try {
        await getScope(c).get(Tokens.SearchService).clearRepo(id);
      } catch (error) {
        console.error('Failed to purge code index', fullName, ErrorSanitizationUtil.sanitizeErrorForLogging(error));
      }
      return c.json({ ok: true, id });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to delete repo'), toServiceStatus(error));
    }
  });
}

// Read-model passthroughs (branches/tree/blob/commits/overview) via DO RPC
// live in `RepoReadModelRoutes` (god-file guard); param parsers live in
// `RepoParamParsers`. Re-exported here so existing importers
// (`EdgeGitWorker`, route tests) keep working unchanged.
export {
  sanitizeRefParam,
  sanitizePathParam,
  sanitizeDepthParam,
  parseWithLastCommit,
  parseOptionalFlag,
  parseOverviewArgs,
} from './RepoParamParsers';
export { registerUserRepoReadModelRoutes } from './RepoReadModelRoutes';

export { registerRepoRoutes, registerUserRepoRoutes };
