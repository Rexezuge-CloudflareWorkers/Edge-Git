import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { resolvePublicViewer, toRepoJson, toServiceStatus } from './PublicViewerResolver';

type UserApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function parseLimit(url: string): number {
  const raw = new URL(url).searchParams.get('limit');
  const n = raw ? Number(raw) : 100;
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

async function hasVisibleRepo(
  repos: Array<{ id: string }>,
  getRole: (repo: { id: string } & Record<string, unknown>) => Promise<string | null>,
): Promise<boolean> {
  for (const repo of repos) {
    const role = await getRole(repo);
    if (role) return true;
  }
  return false;
}

function registerUserProfileRoutes(app: UserApp): void {
  app.get('/users/:username', async (c) => {
    const username = c.req.param('username');
    const scope = createRequestScope(c.env);
    const rawViewer = await resolvePublicViewer(c as never).catch(() => null);
    const viewerEmail = rawViewer?.toLowerCase() ?? null;
    const user = await scope.get(Tokens.UserService).getByUsername(username).catch(() => null);
    if (user?.username) {
      const permission = scope.get(Tokens.PermissionService);
      let repoCount = 0;
      let orgCount: number | null = null;
      let viewerIsSelf = false;
      try {
        const repoDao = await scope.get(Tokens.RepositoryDAO)();
        const rows = await repoDao.listByOwner(user.username, 200).catch(() => []);
        let visible = 0;
        for (const row of rows) {
          const role = await permission.getRole(viewerEmail, row).catch(() => null);
          if (role) visible += 1;
        }
        repoCount = visible;
      } catch {
        repoCount = 0;
      }
      try {
        const targetEmail = user.email.toLowerCase();
        viewerIsSelf = (viewerEmail ?? '').toLowerCase() === targetEmail;
        const orgs = await scope.get(Tokens.OrganizationService).listOrgsForUser(user.email).catch(() => []);
        if (viewerIsSelf) {
          orgCount = orgs.length;
        } else {
          // Outsiders only see orgs with at least one viewer-visible repo (or shared membership).
          const repoDao = await scope.get(Tokens.RepositoryDAO)().catch(() => null);
          let count = 0;
          for (const org of orgs) {
            let visible = false;
            if (viewerEmail) {
              const role = await scope.get(Tokens.OrganizationService).getMemberRole(org.id, viewerEmail).catch(() => null);
              if (role) visible = true;
            }
            if (!visible && repoDao) {
              const repos = await repoDao.listByOrgId(org.id, 5).catch(() => []);
              visible = await hasVisibleRepo(repos, (repo) =>
                permission.getRole(viewerEmail, repo as never).catch(() => null),
              );
            }
            if (visible) count += 1;
          }
          orgCount = count;
        }
      } catch {
        orgCount = null;
      }
      return c.json({
        type: 'user',
        username: user.username,
        displayName: user.display_name ?? null,
        repoCount,
        orgCount,
        viewerIsSelf,
      });
    }
    // Fall back to org profile so `/:owner` stays unambiguous for clients.
    const org = await scope.get(Tokens.OrganizationService).getByUsername(username).catch(() => null);
    if (!org) return c.json({ error: 'Not found' }, 404);
    let repoCount = 0;
    let memberCount: number | null = null;
    let viewerIsMember = false;
    let viewerIsOwner = false;
    try {
      const permission = scope.get(Tokens.PermissionService);
      const repoDao = await scope.get(Tokens.RepositoryDAO)();
      const byOrg = await repoDao.listByOrgId(org.id, 200).catch(() => []);
      const byOwner = await repoDao.listByOwner(org.username, 200).catch(() => []);
      const seen = new Map<string, (typeof byOrg)[number]>();
      for (const row of [...byOrg, ...byOwner]) seen.set(row.id, row);
      let visible = 0;
      for (const row of seen.values()) {
        const role = await permission.getRole(viewerEmail, row).catch(() => null);
        if (role) visible += 1;
      }
      repoCount = visible;
    } catch {
      repoCount = 0;
    }
    try {
      if (viewerEmail) {
        const role = await scope.get(Tokens.OrganizationService).getMemberRole(org.id, viewerEmail).catch(() => null);
        viewerIsMember = role !== null;
        viewerIsOwner = role === 'owner';
      }
      if (viewerIsMember) {
        const dao = await scope.get(Tokens.OrganizationMemberDAO)();
        const members = await dao.listByOrg(org.id).catch(() => []);
        memberCount = members.length;
      }
    } catch {
      memberCount = null;
    }
    return c.json({
      type: 'org',
      username: org.username,
      displayName: org.display_name ?? null,
      repoCount,
      memberCount,
      viewerIsMember,
      viewerIsOwner,
    });
  });

  // Public repo listing for a profile — viewer-filtered (private hidden).
  app.get('/users/:username/repos', async (c) => {
    const username = c.req.param('username');
    const limit = parseLimit(c.req.url);
    const scope = createRequestScope(c.env);
    const rawViewer = await resolvePublicViewer(c as never).catch(() => null);
    const viewerEmail = rawViewer?.toLowerCase() ?? null;
    const permission = scope.get(Tokens.PermissionService);
    const user = await scope.get(Tokens.UserService).getByUsername(username).catch(() => null);
    if (user?.username) {
      const repoDao = await scope.get(Tokens.RepositoryDAO)();
      const rows = await repoDao.listByOwner(user.username, 200).catch(() => []);
      const repos: unknown[] = [];
      for (const row of rows) {
        const role = await permission.getRole(viewerEmail, row).catch(() => null);
        if (!role) continue;
        if (viewerEmail) {
          repos.push({ ...(toRepoJson(row, role) as Record<string, unknown>), viewerCanManage: role === 'admin', viewerRole: role });
        } else {
          repos.push(toRepoJson(row));
        }
        if (repos.length >= limit) break;
      }
      return c.json({ type: 'user', username: user.username, repos });
    }
    const org = await scope.get(Tokens.OrganizationService).getByUsername(username).catch(() => null);
    if (!org) return c.json({ error: 'Not found' }, 404);
    const repoDao = await scope.get(Tokens.RepositoryDAO)();
    const byOrg = await repoDao.listByOrgId(org.id, 200).catch(() => []);
    const byOwner = await repoDao.listByOwner(org.username, 200).catch(() => []);
    const seen = new Map<string, (typeof byOrg)[number]>();
    for (const row of [...byOrg, ...byOwner]) seen.set(row.id, row);
    const ordered = Array.from(seen.values()).sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    const repos: unknown[] = [];
    for (const row of ordered) {
      const role = await permission.getRole(viewerEmail, row).catch(() => null);
      if (!role) continue;
      if (viewerEmail) {
        repos.push({ ...(toRepoJson(row, role) as Record<string, unknown>), viewerCanManage: role === 'admin', viewerRole: role });
      } else {
        repos.push(toRepoJson(row));
      }
      if (repos.length >= limit) break;
    }
    return c.json({ type: 'org', username: org.username, repos });
  });

  // Public org memberships for a user profile — filtered to viewer-visible orgs.
  app.get('/users/:username/orgs', async (c) => {
    const username = c.req.param('username');
    const scope = createRequestScope(c.env);
    const rawViewer = await resolvePublicViewer(c as never).catch(() => null);
    const viewerEmail = rawViewer?.toLowerCase() ?? null;
    const user = await scope.get(Tokens.UserService).getByUsername(username).catch(() => null);
    if (!user?.username) return c.json({ error: 'Not found' }, 404);
    const orgService = scope.get(Tokens.OrganizationService);
    const orgs = await orgService.listOrgsForUser(user.email).catch(() => []);
    const viewerIsSelf = (viewerEmail ?? '').toLowerCase() === user.email.toLowerCase();
    if (viewerIsSelf) {
      return c.json({ username: user.username, orgs: orgs.map((o) => ({ username: o.username, displayName: o.display_name ?? null })) });
    }
    const permission = scope.get(Tokens.PermissionService);
    const repoDao = await scope.get(Tokens.RepositoryDAO)().catch(() => null);
    const visible: Array<{ username: string; displayName: string | null }> = [];
    for (const org of orgs) {
      let show = false;
      if (viewerEmail) {
        const role = await orgService.getMemberRole(org.id, viewerEmail).catch(() => null);
        if (role) show = true;
      }
      if (!show && repoDao) {
        const repos = await repoDao.listByOrgId(org.id, 5).catch(() => []);
        show = await hasVisibleRepo(repos, (repo) => permission.getRole(viewerEmail, repo as never).catch(() => null));
      }
      if (show) visible.push({ username: org.username, displayName: org.display_name ?? null });
    }
    return c.json({ username: user.username, orgs: visible });
  });
}

function registerUserSettingsRoutes(app: UserApp): void {

  app.patch('/user/me', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const body = (await c.req.json().catch(() => ({}))) as { displayName?: string | null };
    if (body.displayName !== undefined && body.displayName !== null && typeof body.displayName !== 'string') {
      return c.json({ error: 'Invalid displayName' }, 400);
    }
    try {
      const profile = await createRequestScope(c.env).get(Tokens.UserService).updateProfile(email, { displayName: body.displayName ?? null });
      return c.json({ email: profile.email, username: profile.username, displayName: profile.displayName });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed to update profile' }, toServiceStatus(error));
    }
  });

  app.patch('/user/me/username', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const body = (await c.req.json().catch(() => ({}))) as { username?: string };
    if (!body.username || typeof body.username !== 'string') return c.json({ error: 'username is required' }, 400);
    try {
      const scope = createRequestScope(c.env);
      const before = await scope.get(Tokens.UserService).getProfileByEmail(email).catch(() => null);
      const renamed = await scope.get(Tokens.UserService).renameUsername(email, body.username);
      // Best-effort DO move for every owned repo: new stub initialized, old stub purged.
      // D1 is source of truth; git objects copy via fresh init (empty) when DO has no copy RPC.
      if (before?.username && before.username.toLowerCase() !== renamed.username.toLowerCase()) {
        try {
          const repos = await scope.get(Tokens.RepoService).listByOwnerEmail(email, 500);
          const { getRepoStub, ensureRepo } = await import('../repoStub');
          const owned = repos.filter((r) => (r.owner_ci ?? r.owner).toLowerCase() === before.username?.toLowerCase());
          for (const repo of owned) {
            const oldFull = `${before.username}/${repo.name}`;
            const newFull = `${renamed.username}/${repo.name}`;
            try {
              await ensureRepo(c.env, newFull);
              await getRepoStub(c.env, oldFull).deleteRepo().catch(() => undefined);
            } catch {
              // ignore per-repo failures
            }
          }
        } catch {
          // ignore — rename already committed in D1
        }
      }
      const profile = await scope.get(Tokens.UserService).getProfileByEmail(email);
      return c.json({ email: profile.email, username: profile.username, displayName: profile.displayName });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rename';
      const status = message.includes('taken') || message.includes('Invalid') ? 400 : toServiceStatus(error);
      return c.json({ error: message }, status);
    }
  });
}

export { registerUserProfileRoutes, registerUserSettingsRoutes };
