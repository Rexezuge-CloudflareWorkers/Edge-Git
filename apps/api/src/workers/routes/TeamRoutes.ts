import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { toSafeErrorMessage, toServiceStatus } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';

type TeamApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function teamJson(t: {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}): unknown {
  return { id: t.id, slug: t.slug, name: t.name, description: t.description, createdAt: t.created_at, updatedAt: t.updated_at };
}

// Org-scoped teams (`/user/orgs/:org/teams…`). Reads need org membership;
// team create/rename/delete/grants need org ownership; member management
// allows team admins too (enforced in TeamService.requireTeamManager).
function registerTeamRoutes(app: TeamApp): void {
  app.get('/user/orgs/:org/teams', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const teams = await createRequestScope(c.env).get(Tokens.TeamService).listTeams(c.req.param('org'), email);
      return c.json({ teams: teams.map(teamJson) });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
    }
  });

  app.post('/user/orgs/:org/teams', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, body } = await readJsonBody<{ slug?: string; name?: string; description?: string | null }>(c);
    if (malformed) return c.json({ error: 'Invalid JSON body' }, 400);
    if (!body.slug) return c.json({ error: 'slug is required' }, 400);
    try {
      const team = await createRequestScope(c.env)
        .get(Tokens.TeamService)
        .createTeam(c.req.param('org'), email, body as { slug: string });
      return c.json(teamJson(team), 201);
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed') }, toServiceStatus(error));
    }
  });

  app.get('/user/orgs/:org/teams/:team', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const scope = createRequestScope(c.env);
      const { team } = await scope.get(Tokens.TeamService).requireTeam(c.req.param('org'), c.req.param('team'));
      await scope.get(Tokens.OrganizationService).requireMember(c.req.param('org'), email);
      return c.json(teamJson(team));
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
    }
  });

  app.patch('/user/orgs/:org/teams/:team', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, body } = await readJsonBody<{ slug?: string; name?: string; description?: string | null }>(c);
    if (malformed) return c.json({ error: 'Invalid JSON body' }, 400);
    try {
      const team = await createRequestScope(c.env).get(Tokens.TeamService).renameTeam(c.req.param('org'), c.req.param('team'), email, body);
      return c.json(teamJson(team));
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed') }, toServiceStatus(error));
    }
  });

  app.delete('/user/orgs/:org/teams/:team', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      await createRequestScope(c.env).get(Tokens.TeamService).deleteTeam(c.req.param('org'), c.req.param('team'), email);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed') }, toServiceStatus(error));
    }
  });

  app.get('/user/orgs/:org/teams/:team/members', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const members = await createRequestScope(c.env).get(Tokens.TeamService).listMembers(c.req.param('org'), c.req.param('team'), email);
      return c.json({ members });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
    }
  });

  app.post('/user/orgs/:org/teams/:team/members', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, body } = await readJsonBody<{ username?: string; email?: string; role?: string }>(c);
    if (malformed) return c.json({ error: 'Invalid JSON body' }, 400);
    const target = body.username ?? body.email;
    if (!target) return c.json({ error: 'username or email is required' }, 400);
    const role = body.role ?? 'member';
    if (role !== 'admin' && role !== 'member') return c.json({ error: 'Invalid role' }, 400);
    try {
      await createRequestScope(c.env).get(Tokens.TeamService).addMember(c.req.param('org'), c.req.param('team'), email, target, role);
      return c.json({ ok: true }, 201);
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed') }, toServiceStatus(error));
    }
  });

  app.patch('/user/orgs/:org/teams/:team/members/:member', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, body } = await readJsonBody<{ role?: string }>(c);
    if (malformed) return c.json({ error: 'Invalid JSON body' }, 400);
    if (body.role !== 'admin' && body.role !== 'member') return c.json({ error: 'Invalid role' }, 400);
    try {
      await createRequestScope(c.env)
        .get(Tokens.TeamService)
        .setMemberRole(c.req.param('org'), c.req.param('team'), email, decodeURIComponent(c.req.param('member')), body.role);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed') }, toServiceStatus(error));
    }
  });

  app.delete('/user/orgs/:org/teams/:team/members/:member', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      await createRequestScope(c.env)
        .get(Tokens.TeamService)
        .removeMember(c.req.param('org'), c.req.param('team'), email, decodeURIComponent(c.req.param('member')));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed') }, toServiceStatus(error));
    }
  });

  app.get('/user/orgs/:org/teams/:team/repos', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const scope = createRequestScope(c.env);
      const grants = await scope.get(Tokens.TeamService).listGrants(c.req.param('org'), c.req.param('team'), email);
      const repos: Array<{ repoId: string; fullName: string | null; role: string }> = [];
      for (const g of grants) {
        let fullName: string | null = null;
        try {
          const row = await scope.get(Tokens.RepoService).getById(g.repoId);
          fullName = row ? `${row.owner}/${row.name}` : null;
        } catch {
          fullName = null;
        }
        repos.push({ repoId: g.repoId, fullName, role: g.role });
      }
      return c.json({ repos });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
    }
  });

  app.put('/user/orgs/:org/teams/:team/repos/:owner/:repo', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, body } = await readJsonBody<{ role?: string }>(c);
    if (malformed) return c.json({ error: 'Invalid JSON body' }, 400);
    const role = body.role ?? 'read';
    if (role !== 'admin' && role !== 'write' && role !== 'read') return c.json({ error: 'Invalid role' }, 400);
    try {
      const scope = createRequestScope(c.env);
      const repo = await scope
        .get(Tokens.RepoService)
        .getByOwnerAndName(c.req.param('owner'), RepoService.normalizeRepo(c.req.param('repo')));
      if (!repo) return c.json({ error: 'Repository not found' }, 404);
      await scope.get(Tokens.TeamService).grantRepo(c.req.param('org'), c.req.param('team'), email, repo.id, role);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed') }, toServiceStatus(error));
    }
  });

  app.delete('/user/orgs/:org/teams/:team/repos/:owner/:repo', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const scope = createRequestScope(c.env);
      const repo = await scope
        .get(Tokens.RepoService)
        .getByOwnerAndName(c.req.param('owner'), RepoService.normalizeRepo(c.req.param('repo')));
      if (!repo) return c.json({ error: 'Repository not found' }, 404);
      await scope.get(Tokens.TeamService).revokeGrant(c.req.param('org'), c.req.param('team'), email, repo.id);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed') }, toServiceStatus(error));
    }
  });
}

export { registerTeamRoutes };
