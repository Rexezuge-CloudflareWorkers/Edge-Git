import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { presentMany, presentSingle } from './IdentityPresenter';
import { RepoFullName } from '@edge-git/shared/utils';
import { getRepoStub } from '../doStubs';
import { recordAndNotify } from './SocialEmit';
import { jsonError, requireVisibleRepo, resolvePublicViewer, toSafeErrorMessage, toServiceStatus, withPublicRepo } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';

type ReleaseApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

async function viewerCanSeeDrafts(env: Env, viewerEmail: string | null, owner: string, repoName: string): Promise<boolean> {
  try {
    const scope = createRequestScope(env);
    const row = await scope.get(Tokens.RepoService).getByOwnerAndName(owner, repoName);
    if (!row) return false;
    const role = await scope.get(Tokens.PermissionService).getRole(viewerEmail, row);
    return role === 'write' || role === 'admin';
  } catch {
    return false;
  }
}

async function tagExists(env: Env, fullName: string, tagName: string): Promise<boolean> {
  try {
    const tags = (await getRepoStub(env, fullName).getTags()) as Array<{ name: string }>;
    return tags.some((t) => t.name === tagName);
  } catch {
    return false;
  }
}

function registerReleasePublicRoutes(app: ReleaseApp): void {
  app.get('/repos/:owner/:repo/releases', async (c) => {
    return withPublicRepo(c, async (row) => {
      try {
        const viewerEmail = await resolvePublicViewer(c);
        const canSeeDrafts = await viewerCanSeeDrafts(c.env, viewerEmail, row.owner, row.name);
        const scope = createRequestScope(c.env);
        const releases = await scope.get(Tokens.ReleaseService).listReleases(row.id);
        const visible = canSeeDrafts ? releases : releases.filter((r) => !r.isDraft);
        return c.json({ releases: await presentMany(scope, visible) });
      } catch {
        return c.json({ releases: [] });
      }
    });
  });

  app.get('/repos/:owner/:repo/releases/:tag', async (c) => {
    return withPublicRepo(c, async (row) => {
      try {
        const scope = createRequestScope(c.env);
        const release = await scope.get(Tokens.ReleaseService).getRelease(row.id, c.req.param('tag'));
        if (release.isDraft) {
          const viewerEmail = await resolvePublicViewer(c);
          if (!(await viewerCanSeeDrafts(c.env, viewerEmail, row.owner, row.name))) return jsonError(c, 'Not found', 404);
        }
        const assets = await scope.get(Tokens.ReleaseService).listAssets(row.id, release.tagName);
        return c.json({ release: await presentSingle(scope, release), assets: await presentMany(scope, assets) });
      } catch (error) {
        return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
      }
    });
  });
}

function registerReleaseUserRoutes(app: ReleaseApp): void {
  app.get('/user/repos/:owner/:repo/releases', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      const scope = createRequestScope(c.env);
      const releases = await scope.get(Tokens.ReleaseService).listReleases(row.id);
      const canSeeDrafts = await viewerCanSeeDrafts(c.env, email, owner, repoName);
      const visible = canSeeDrafts ? releases : releases.filter((r) => !r.isDraft);
      return c.json({ releases: await presentMany(scope, visible) });
    } catch {
      return c.json({ releases: [] });
    }
  });

  app.post('/user/repos/:owner/:repo/releases', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return jsonError(c, 'Forbidden', 403);
    }
    const { malformed, body } = await readJsonBody<{
      tagName?: unknown;
      name?: unknown;
      body?: unknown;
      isDraft?: unknown;
      isPrerelease?: unknown;
    }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = createRequestScope(c.env);
      const isDraft = body.isDraft === undefined || body.isDraft === true;
      if (!isDraft && typeof body.tagName === 'string') {
        const fullName = `${row.owner}/${row.name}`;
        if (!(await tagExists(c.env, fullName, body.tagName.trim().replace(/\.git$/i, '')))) {
          return jsonError(c, 'git tag does not exist yet — create the tag first or save as draft', 400);
        }
      }
      const release = await scope
        .get(Tokens.ReleaseService)
        .createRelease(
          row.id,
          { tagName: body.tagName, name: body.name, body: body.body, isDraft: body.isDraft, isPrerelease: body.isPrerelease },
          email,
        );
      const fullName = `${row.owner}/${row.name}`;
      void recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName,
        actorEmail: email,
        type: 'release_created',
        title: `Release ${release.tagName} created`,
        subjectType: 'release',
        subjectOid: null,
        payload: { tag: release.tagName, draft: release.isDraft },
      });
      return c.json({ release: await presentSingle(scope, release) }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create release'), toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/releases/:tag', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      const scope = createRequestScope(c.env);
      const release = await scope.get(Tokens.ReleaseService).getRelease(row.id, c.req.param('tag'));
      if (release.isDraft && !(await viewerCanSeeDrafts(c.env, email, owner, repoName))) return jsonError(c, 'Not found', 404);
      const assets = await scope.get(Tokens.ReleaseService).listAssets(row.id, release.tagName);
      return c.json({ release: await presentSingle(scope, release), assets: await presentMany(scope, assets) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/releases/:tag', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return jsonError(c, 'Forbidden', 403);
    }
    const { malformed, body } = await readJsonBody<{ name?: unknown; body?: unknown; isDraft?: unknown; isPrerelease?: unknown }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = createRequestScope(c.env);
      const before = await scope.get(Tokens.ReleaseService).getRelease(row.id, c.req.param('tag'));
      if (before.isDraft && body.isDraft === false) {
        const fullName = `${row.owner}/${row.name}`;
        if (!(await tagExists(c.env, fullName, before.tagName))) {
          return jsonError(c, 'git tag does not exist yet — push the tag before publishing', 400);
        }
      }
      const release = await scope.get(Tokens.ReleaseService).updateRelease(row.id, c.req.param('tag'), body);
      if (before.isDraft && !release.isDraft) {
        const fullName = `${row.owner}/${row.name}`;
        void recordAndNotify(c.env, {
          repositoryId: row.id,
          fullName,
          actorEmail: email,
          type: 'release_published',
          title: `Release ${release.tagName} published`,
          subjectType: 'release',
          subjectOid: null,
          payload: { tag: release.tagName, prerelease: release.isPrerelease },
        });
      }
      return c.json({ release: await presentSingle(scope, release) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update release'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/releases/:tag', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return jsonError(c, 'Forbidden', 403);
    }
    try {
      const scope = createRequestScope(c.env);
      const release = await scope.get(Tokens.ReleaseService).getRelease(row.id, c.req.param('tag'));
      try {
        await getRepoStub(c.env, `${row.owner}/${row.name}`).deleteReleaseAssets({ releaseId: release.id });
      } catch {
        // best-effort DO cleanup; D1 delete below still runs
      }
      await scope.get(Tokens.ReleaseService).deleteRelease(row.id, release.tagName);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });
}

export { registerReleasePublicRoutes, registerReleaseUserRoutes, viewerCanSeeDrafts };
export type { ReleaseApp };
