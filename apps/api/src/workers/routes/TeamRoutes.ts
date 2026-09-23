import type { Hono } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import { jsonError, toSafeErrorMessage, toServiceStatus, getScope } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';

type TeamApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

// Pure Strategy helper: Hono already decodes params, but a literal `%` in the
// route still reaches `decodeURIComponent` here. Guard the URIError so a
// malformed member becomes 400 instead of an uncaught 500.
function decodeMemberParam(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

// Pure normalization: trim whitespace; lowercase emails so `Foo@Bar.com `
// resolves to the same user. Usernames keep case (resolved case-insensitively
// downstream via IdentityResolver/TeamService).
function normalizeMemberTarget(input: string): string {
  const trimmed = input.trim();
  return trimmed.includes('@') ? trimmed.toLowerCase() : trimmed;
}

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
      const teams = await getScope(c).get(Tokens.TeamService).listTeams(c.req.param('org'), email);
      return c.json({ teams: teams.map(teamJson) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.post('/user/orgs/:org/teams', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, oversized, body } = await readJsonBody<{ slug?: string; name?: string; description?: string | null }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (!body.slug) return jsonError(c, 'slug is required', 400);
    try {
      const team = await getScope(c)
        .get(Tokens.TeamService)
        .createTeam(c.req.param('org'), email, body as { slug: string });
      return c.json(teamJson(team), 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });

  app.get('/user/orgs/:org/teams/:team', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const scope = getScope(c);
      const { team } = await scope.get(Tokens.TeamService).requireTeam(c.req.param('org'), c.req.param('team'));
      await scope.get(Tokens.OrganizationService).requireMember(c.req.param('org'), email);
      return c.json(teamJson(team));
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.patch('/user/orgs/:org/teams/:team', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, oversized, body } = await readJsonBody<{ slug?: string; name?: string; description?: string | null }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const team = await getScope(c).get(Tokens.TeamService).renameTeam(c.req.param('org'), c.req.param('team'), email, body);
      return c.json(teamJson(team));
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });

  app.delete('/user/orgs/:org/teams/:team', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      await getScope(c).get(Tokens.TeamService).deleteTeam(c.req.param('org'), c.req.param('team'), email);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });

  app.get('/user/orgs/:org/teams/:team/members', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const members = await getScope(c).get(Tokens.TeamService).listMembers(c.req.param('org'), c.req.param('team'), email);
      return c.json({ members });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.post('/user/orgs/:org/teams/:team/members', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, oversized, body } = await readJsonBody<{ username?: string; email?: string; role?: string }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    const target = body.username ?? body.email;
    if (!target) return jsonError(c, 'username or email is required', 400);
    const normalizedTarget = normalizeMemberTarget(target);
    if (!normalizedTarget) return jsonError(c, 'username or email is required', 400);
    const role = body.role ?? 'member';
    if (role !== 'admin' && role !== 'member') return jsonError(c, 'Invalid role', 400);
    try {
      await getScope(c).get(Tokens.TeamService).addMember(c.req.param('org'), c.req.param('team'), email, normalizedTarget, role);
      return c.json({ ok: true }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });

  app.patch('/user/orgs/:org/teams/:team/members/:member', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, oversized, body } = await readJsonBody<{ role?: string }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (body.role !== 'admin' && body.role !== 'member') return jsonError(c, 'Invalid role', 400);
    const member = decodeMemberParam(c.req.param('member'));
    if (member === null || !member) return jsonError(c, 'Invalid member', 400);
    try {
      await getScope(c).get(Tokens.TeamService).setMemberRole(c.req.param('org'), c.req.param('team'), email, member, body.role);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });

  app.delete('/user/orgs/:org/teams/:team/members/:member', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const member = decodeMemberParam(c.req.param('member'));
    if (member === null || !member) return jsonError(c, 'Invalid member', 400);
    try {
      await getScope(c).get(Tokens.TeamService).removeMember(c.req.param('org'), c.req.param('team'), email, member);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });

  app.get('/user/orgs/:org/teams/:team/repos', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const scope = getScope(c);
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
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.put('/user/orgs/:org/teams/:team/repos/:owner/:repo', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, oversized, body } = await readJsonBody<{ role?: string }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    const role = body.role ?? 'read';
    if (role !== 'admin' && role !== 'write' && role !== 'read') return jsonError(c, 'Invalid role', 400);
    try {
      const scope = getScope(c);
      const repo = await scope
        .get(Tokens.RepoService)
        .getByOwnerAndName(c.req.param('owner'), RepoFullName.normalizeRepo(c.req.param('repo')));
      if (!repo) return jsonError(c, 'Repository not found', 404);
      await scope.get(Tokens.TeamService).grantRepo(c.req.param('org'), c.req.param('team'), email, repo.id, role);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });

  app.delete('/user/orgs/:org/teams/:team/repos/:owner/:repo', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const scope = getScope(c);
      const repo = await scope
        .get(Tokens.RepoService)
        .getByOwnerAndName(c.req.param('owner'), RepoFullName.normalizeRepo(c.req.param('repo')));
      if (!repo) return jsonError(c, 'Repository not found', 404);
      await scope.get(Tokens.TeamService).revokeGrant(c.req.param('org'), c.req.param('team'), email, repo.id);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });
}

export { registerTeamRoutes, decodeMemberParam, normalizeMemberTarget };
