import type { Hono } from 'hono';
import { getRepoStub, ensureRepo } from '../repoStub';
import { requireVisibleRepo, toRepoJson, toServiceStatus, withPublicRepo } from './PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import type { RequestContext } from '@/middleware';

type RepoApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

// Public read-model API — anonymous OK for public repos (private → 404
// unless the caller presents Access identity or a PAT for the owner).
function registerRepoRoutes(app: RepoApp): void {
  app.get('/repos/:owner/:repo', async (c) => {
    return withPublicRepo(c as never, (row) => Promise.resolve(c.json(toRepoJson(row))));
  });

  app.get('/repos/:owner/:repo/branches', async (c) => {
    return withPublicRepo(c as never, async (_row, fullName) => c.json(await getRepoStub(c.env, fullName).getBranches()));
  });

  app.get('/repos/:owner/:repo/tree', async (c) => {
    return withPublicRepo(c as never, async (_row, fullName) => {
      const url = new URL(c.req.url);
      return c.json(
        await getRepoStub(c.env, fullName).getTree({
          ref: url.searchParams.get('ref') ?? undefined,
          path: url.searchParams.get('path') ?? undefined,
        }),
      );
    });
  });

  app.get('/repos/:owner/:repo/blob', async (c) => {
    return withPublicRepo(c as never, async (_row, fullName) => {
      const url = new URL(c.req.url);
      return c.json(
        await getRepoStub(c.env, fullName).getBlob({
          ref: url.searchParams.get('ref') ?? undefined,
          filepath: url.searchParams.get('path') ?? '',
        }),
      );
    });
  });

  app.get('/repos/:owner/:repo/commits', async (c) => {
    return withPublicRepo(c as never, async (_row, fullName) => {
      const url = new URL(c.req.url);
      const depth = url.searchParams.get('depth');
      return c.json(
        await getRepoStub(c.env, fullName).getCommits({
          ref: url.searchParams.get('ref') ?? undefined,
          depth: depth ? Number(depth) : undefined,
        }),
      );
    });
  });
}

// Protected repo CRUD behind /user/* Access auth (plus /user/me identity).
function registerUserRepoRoutes(app: RepoApp): void {
  app.get('/user/me', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const profile = await createRequestScope(c.env).get(Tokens.UserService).getProfileByEmail(email);
      return c.json({ email: profile.email, username: profile.username, displayName: profile.displayName });
    } catch {
      return c.json({ email });
    }
  });

  app.get('/user/repos', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const scope = createRequestScope(c.env);
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
    const body = (await c.req.json().catch(() => ({}))) as {
      owner?: string;
      name?: string;
      description?: string | null;
      isPrivate?: boolean;
    };
    const scope = createRequestScope(c.env);
    let owner = (body.owner ?? '').trim();
    if (!owner) {
      try {
        const profile = await scope.get(Tokens.UserService).getProfileByEmail(email);
        owner = (profile.username ?? email.split('@', 1)[0]).trim();
      } catch {
        owner = email.split('@', 1)[0].trim();
      }
    }
    const name = (body.name ?? '').trim();
    if (!name) return c.json({ error: 'name is required' }, 400);
    try {
      RepoService.validateNames(owner, RepoService.normalizeRepo(name));
      const svc = scope.get(Tokens.RepoService);
      const normalized = RepoService.normalizeRepo(name);
      const { id } = await svc.createRepo(email, owner, normalized, body.description ?? null, body.isPrivate ?? false);
      const created = await svc.getByOwnerAndName(owner, normalized);
      const canonicalOwner = created?.owner ?? owner;
      await ensureRepo(c.env, `${canonicalOwner}/${normalized}`);
      return c.json({ id, owner: canonicalOwner, name: normalized, fullName: `${canonicalOwner}/${normalized}` }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create repo';
      const status =
        message.includes('already exists') || message.includes('Invalid') || message.includes('Maximum') ? 400 : message.includes('members') || message.includes('owner') ? 403 : 500;
      return c.json({ error: message }, status as 400);
    }
  });

  app.get('/user/repos/:owner/:repo', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const scope = createRequestScope(c.env);
    const row = await requireVisibleRepo(c.env, c.req.param('owner'), RepoService.normalizeRepo(c.req.param('repo')), email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const role = await scope.get(Tokens.PermissionService).getRole(email, row).catch(() => null);
    return c.json({ ...(toRepoJson(row, role) as Record<string, unknown>), viewerCanManage: role === 'admin', viewerRole: role });
  });

  app.patch('/user/repos/:owner/:repo', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const body = (await c.req.json().catch(() => ({}))) as { description?: string | null; isPrivate?: boolean };
    const patch: { description?: string | null; isPrivate?: boolean } = {};
    if ('description' in body) patch.description = body.description ?? null;
    if ('isPrivate' in body) patch.isPrivate = body.isPrivate;
    if (patch.description === undefined && patch.isPrivate === undefined) {
      return c.json({ error: 'Nothing to update' }, 400);
    }
    try {
      const updated = await createRequestScope(c.env).get(Tokens.RepoService).updateRepo(owner, repoName, email, patch);
      return c.json({ ...(toRepoJson(updated) as Record<string, unknown>), viewerCanManage: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to update repo' }, toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    try {
      const { id } = await createRequestScope(c.env).get(Tokens.RepoService).deleteRepo(owner, repoName, email);
      // Purge git objects from the Durable Object (best-effort; D1 is source of truth).
      const fullName = `${owner}/${repoName}`;
      try {
        await getRepoStub(c.env, fullName).deleteRepo();
      } catch (error) {
        console.error('Failed to purge repo DO', fullName, error);
      }
      return c.json({ ok: true, id });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to delete repo' }, toServiceStatus(error));
    }
  });
}

// Read-model passthroughs (branches/tree/blob/commits) via DO RPC.
async function withVisibleRepo(c: RequestContext, owner: string, repoName: string, fn: (fullName: string) => Promise<Response>): Promise<Response> {
  const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
  if (!row) return c.json({ error: 'Not found' }, 404);
  return fn(`${owner}/${repoName}`);
}

function registerUserRepoReadModelRoutes(app: RepoApp): void {
  app.get('/user/repos/:owner/:repo/branches', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    return withVisibleRepo(c as never, owner, repoName, async (fullName) => c.json(await getRepoStub(c.env, fullName).getBranches()));
  });

  app.get('/user/repos/:owner/:repo/tree', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const url = new URL(c.req.url);
    return withVisibleRepo(
      c as never,
      owner,
      repoName,
      async (fullName) =>
        c.json(await getRepoStub(c.env, fullName).getTree({ ref: url.searchParams.get('ref') ?? undefined, path: url.searchParams.get('path') ?? undefined })),
    );
  });

  app.get('/user/repos/:owner/:repo/blob', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const url = new URL(c.req.url);
    const filepath = url.searchParams.get('path') ?? '';
    return withVisibleRepo(
      c as never,
      owner,
      repoName,
      async (fullName) => c.json(await getRepoStub(c.env, fullName).getBlob({ ref: url.searchParams.get('ref') ?? undefined, filepath })),
    );
  });

  app.get('/user/repos/:owner/:repo/commits', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const url = new URL(c.req.url);
    const depth = url.searchParams.get('depth');
    return withVisibleRepo(
      c as never,
      owner,
      repoName,
      async (fullName) =>
        c.json(await getRepoStub(c.env, fullName).getCommits({ ref: url.searchParams.get('ref') ?? undefined, depth: depth ? Number(depth) : undefined })),
    );
  });
}

export { registerRepoRoutes, registerUserRepoRoutes, registerUserRepoReadModelRoutes };
