import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { resolvePublicViewer, toRepoJson, toSafeErrorMessage, toServiceStatus } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';

type UserApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function parseLimit(url: string): number {
  const raw = new URL(url).searchParams.get('limit');
  // Invalid values fall back to a safe default (20), never to the max:
  // `?limit=abc` must not silently become a 100-row over-fetch.
  if (raw === null || raw.trim() === '') return 20;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 20;
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
    const user = await scope
      .get(Tokens.UserService)
      .getByUsername(username)
      .catch(() => null);
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
        const orgs = await scope
          .get(Tokens.OrganizationService)
          .listOrgsForUser(user.email)
          .catch(() => []);
        if (viewerIsSelf) {
          orgCount = orgs.length;
        } else {
          // Outsiders only see orgs with at least one viewer-visible repo (or shared membership).
          const repoDao = await scope
            .get(Tokens.RepositoryDAO)()
            .catch(() => null);
          let count = 0;
          for (const org of orgs) {
            let visible = false;
            if (viewerEmail) {
              const role = await scope
                .get(Tokens.OrganizationService)
                .getMemberRole(org.id, viewerEmail)
                .catch(() => null);
              if (role) visible = true;
            }
            if (!visible && repoDao) {
              const repos = await repoDao.listByOrgId(org.id, 5).catch(() => []);
              visible = await hasVisibleRepo(repos, (repo) => permission.getRole(viewerEmail, repo as never).catch(() => null));
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
        repoCount,
        orgCount,
        viewerIsSelf,
      });
    }
    // Fall back to org profile so `/:owner` stays unambiguous for clients.
    const org = await scope
      .get(Tokens.OrganizationService)
      .getByUsername(username)
      .catch(() => null);
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
        const role = await scope
          .get(Tokens.OrganizationService)
          .getMemberRole(org.id, viewerEmail)
          .catch(() => null);
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
    const user = await scope
      .get(Tokens.UserService)
      .getByUsername(username)
      .catch(() => null);
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
    const org = await scope
      .get(Tokens.OrganizationService)
      .getByUsername(username)
      .catch(() => null);
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
    const user = await scope
      .get(Tokens.UserService)
      .getByUsername(username)
      .catch(() => null);
    if (!user?.username) return c.json({ error: 'Not found' }, 404);
    const orgService = scope.get(Tokens.OrganizationService);
    const orgs = await orgService.listOrgsForUser(user.email).catch(() => []);
    const viewerIsSelf = (viewerEmail ?? '').toLowerCase() === user.email.toLowerCase();
    if (viewerIsSelf) {
      return c.json({ username: user.username, orgs: orgs.map((o) => ({ username: o.username })) });
    }
    const permission = scope.get(Tokens.PermissionService);
    const repoDao = await scope
      .get(Tokens.RepositoryDAO)()
      .catch(() => null);
    const visible: Array<{ username: string }> = [];
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
      if (show) visible.push({ username: org.username });
    }
    return c.json({ username: user.username, orgs: visible });
  });
}

function registerUserSettingsRoutes(app: UserApp): void {
  app.patch('/user/me/username', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, body } = await readJsonBody<{ username?: string }>(c);
    if (malformed) return c.json({ error: 'Invalid JSON body' }, 400);
    if (!body.username || typeof body.username !== 'string') return c.json({ error: 'username is required' }, 400);
    try {
      const scope = createRequestScope(c.env);
      const before = await scope
        .get(Tokens.UserService)
        .getProfileByEmail(email)
        .catch(() => null);
      // Snapshot owned repos BEFORE the D1 rename — afterwards `owner_ci`
      // already reads new, so a post-rename filter by the old name matches
      // nothing and the DO move silently never runs.
      const snapshot: Array<{ id: string; name: string }> = [];
      if (before?.username) {
        const seen = new Set<string>();
        const remember = (rows: Array<{ id: string; name: string }>): void => {
          for (const row of rows) {
            if (!row.id || !row.name || seen.has(row.id)) continue;
            seen.add(row.id);
            snapshot.push({ id: row.id, name: row.name });
          }
        };
        try {
          remember(await scope.get(Tokens.RepoService).listByOwnerEmail(email, 1000));
        } catch {
          // ignore — DAO snapshot below still applies
        }
        try {
          remember(await scope.get(Tokens.RepositoryDAO)().then((dao) => dao.listByOwner(before.username as string, 1000)));
        } catch {
          // ignore — owner_email snapshot above still applies
        }
      }
      const renamed = await scope.get(Tokens.UserService).renameUsername(email, body.username);
      // Fail-closed DO move: git objects + release assets are copied old→new
      // and the old isolate is purged only after the copy verifies. On copy
      // failure the new isolate is purged, D1 is rolled back to the old
      // handle, and the request surfaces 413 (pack limit) / 500.
      if (before?.username && before.username.toLowerCase() !== renamed.username.toLowerCase()) {
        const moves = snapshot.map((repo) => ({
          id: repo.id,
          name: repo.name,
          oldFull: `${before.username as string}/${repo.name}`,
          newFull: `${renamed.username}/${repo.name}`,
        }));
        if (moves.length > 0) {
          const { moveRepoDosForRename } = await import('./RepoMove');
          const { isPackLimitError } = await import('./CrossFork');
          try {
            await moveRepoDosForRename(c.env, email, moves);
          } catch (moveError) {
            await scope
              .get(Tokens.UserService)
              .renameUsername(email, before.username)
              .catch(() => undefined);
            if (isPackLimitError(moveError)) {
              return c.json({ error: moveError instanceof Error ? moveError.message : 'Repository too large to move' }, 413);
            }
            return c.json({ error: 'Failed to move repository data' }, 500);
          }
        }
      }
      const profile = await scope.get(Tokens.UserService).getProfileByEmail(email);
      return c.json({ email: profile.email, username: profile.username });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to rename';
      const status =
        message.includes('taken') || message.includes('Invalid') || message.includes('reserved') ? 400 : toServiceStatus(error);
      return c.json({ error: toSafeErrorMessage(error, 'Failed to rename') }, status);
    }
  });
}

export { registerUserProfileRoutes, registerUserSettingsRoutes };
