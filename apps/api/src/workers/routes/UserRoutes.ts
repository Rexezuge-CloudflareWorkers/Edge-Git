import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { toServiceStatus } from './PublicViewerResolver';

type UserApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function registerUserProfileRoutes(app: UserApp): void {
  app.get('/users/:username', async (c) => {
    const username = c.req.param('username');
    const user = await createRequestScope(c.env).get(Tokens.UserService).getByUsername(username).catch(() => null);
    if (!user || !user.username) {
      // Fall back to org profile so `/:owner` stays unambiguous for clients.
      const org = await createRequestScope(c.env).get(Tokens.OrganizationService).getByUsername(username).catch(() => null);
      if (!org) return c.json({ error: 'Not found' }, 404);
      return c.json({ type: 'org', username: org.username, displayName: org.display_name ?? null });
    }
    return c.json({ type: 'user', username: user.username, displayName: user.display_name ?? null });
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
