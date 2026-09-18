import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { toServiceStatus } from './PublicViewerResolver';

type OrgApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function registerOrgRoutes(app: OrgApp): void {
  app.post('/user/orgs', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const body = (await c.req.json().catch(() => ({}))) as { username?: string };
    if (!body.username) return c.json({ error: 'username is required' }, 400);
    try {
      const org = await createRequestScope(c.env).get(Tokens.OrganizationService).createOrganization(email, body.username);
      return c.json({ id: org.id, username: org.username }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create organization';
      const status =
        message.includes('taken') || message.includes('Invalid') || message.includes('reserved') ? 400 : toServiceStatus(error);
      return c.json({ error: message }, status);
    }
  });

  app.get('/user/orgs', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const orgs = await createRequestScope(c.env).get(Tokens.OrganizationService).listOrgsForUser(email);
    return c.json({ orgs: orgs.map((o) => ({ id: o.id, username: o.username })) });
  });

  app.get('/user/orgs/:org', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const orgName = c.req.param('org');
    try {
      const scope = createRequestScope(c.env);
      const org = await scope.get(Tokens.OrganizationService).requireMember(orgName, email);
      const members = await scope.get(Tokens.OrganizationService).listMembers(org.username, email);
      const viewerRole = await scope
        .get(Tokens.OrganizationService)
        .getMemberRole(org.id, email)
        .catch(() => null);
      return c.json({ id: org.id, username: org.username, members, viewerRole });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  app.patch('/user/orgs/:org', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const orgName = c.req.param('org');
    const body = (await c.req.json().catch(() => ({}))) as { username?: string };
    try {
      const scope = createRequestScope(c.env);
      let org = await scope.get(Tokens.OrganizationService).requireOwner(orgName, email);
      if (body.username) {
        const before = org.username;
        // Snapshot org repos BEFORE the D1 rename — afterwards `owner_ci`
        // already reads new, so a post-rename filter by the old name matches
        // nothing and the DO move silently never runs. `org_id`-keyed rows
        // plus legacy owner-named rows cover backfill gaps.
        const snapshot: Array<{ id: string; name: string }> = [];
        const seen = new Set<string>();
        const remember = (rows: Array<{ id: string; name: string }>): void => {
          for (const row of rows) {
            if (!row.id || !row.name || seen.has(row.id)) continue;
            seen.add(row.id);
            snapshot.push({ id: row.id, name: row.name });
          }
        };
        try {
          remember(await scope.get(Tokens.RepositoryDAO)().then((dao) => dao.listByOrgId(org.id, 1000)));
        } catch {
          // ignore — owner snapshot below still applies
        }
        try {
          remember(await scope.get(Tokens.RepositoryDAO)().then((dao) => dao.listByOwner(before, 1000)));
        } catch {
          // ignore — org_id snapshot above still applies
        }
        org = await scope.get(Tokens.OrganizationService).rename(org.username, email, body.username);
        // Fail-closed DO move: git objects + release assets are copied old→new
        // and the old isolate is purged only after the copy verifies. On copy
        // failure the new isolate is purged, D1 is rolled back to the old
        // handle, and the request surfaces 413 (pack limit) / 500.
        if (before.toLowerCase() !== org.username.toLowerCase()) {
          const moves = snapshot.map((repo) => ({
            id: repo.id,
            name: repo.name,
            oldFull: `${before}/${repo.name}`,
            newFull: `${org.username}/${repo.name}`,
          }));
          if (moves.length > 0) {
            const { moveRepoDosForRename } = await import('./RepoMove');
            const { isPackLimitError } = await import('./CrossFork');
            try {
              await moveRepoDosForRename(c.env, email, moves);
            } catch (moveError) {
              await scope
                .get(Tokens.OrganizationService)
                .rename(org.username, email, before)
                .catch(() => undefined);
              if (isPackLimitError(moveError)) {
                return c.json({ error: moveError instanceof Error ? moveError.message : 'Repository too large to move' }, 413);
              }
              return c.json({ error: 'Failed to move repository data' }, 500);
            }
          }
        }
      }
      return c.json({ id: org.id, username: org.username });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update organization';
      const status =
        message.includes('taken') || message.includes('Invalid') || message.includes('reserved') ? 400 : toServiceStatus(error);
      return c.json({ error: message }, status);
    }
  });

  app.delete('/user/orgs/:org', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      await createRequestScope(c.env).get(Tokens.OrganizationService).disband(c.req.param('org'), email);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed' }, toServiceStatus(error));
    }
  });

  app.get('/user/orgs/:org/members', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const members = await createRequestScope(c.env).get(Tokens.OrganizationService).listMembers(c.req.param('org'), email);
      return c.json({ members });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  app.post('/user/orgs/:org/members', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const body = (await c.req.json().catch(() => ({}))) as { username?: string; email?: string; role?: string };
    const target = body.username ?? body.email;
    if (!target) return c.json({ error: 'username or email is required' }, 400);
    const role = body.role ?? 'member';
    if (role !== 'owner' && role !== 'member') return c.json({ error: 'Invalid role' }, 400);
    try {
      await createRequestScope(c.env).get(Tokens.OrganizationService).addMember(c.req.param('org'), email, target, role);
      return c.json({ ok: true }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed' }, toServiceStatus(error));
    }
  });

  app.patch('/user/orgs/:org/members/:member', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const body = (await c.req.json().catch(() => ({}))) as { role?: string };
    if (body.role !== 'owner' && body.role !== 'member') return c.json({ error: 'Invalid role' }, 400);
    try {
      await createRequestScope(c.env)
        .get(Tokens.OrganizationService)
        .setMemberRole(c.req.param('org'), email, decodeURIComponent(c.req.param('member')), body.role);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed' }, toServiceStatus(error));
    }
  });

  app.delete('/user/orgs/:org/members/:member', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      await createRequestScope(c.env)
        .get(Tokens.OrganizationService)
        .removeMember(c.req.param('org'), email, decodeURIComponent(c.req.param('member')));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed' }, toServiceStatus(error));
    }
  });

  // Collaborators: admin-only per repo.
  app.get('/user/repos/:owner/:repo/collaborators', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    try {
      const scope = createRequestScope(c.env);
      await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const repo = await scope.get(Tokens.RepoService).getByOwnerAndName(owner, repoName);
      if (!repo) return c.json({ error: 'Not found' }, 404);
      const collabDao = await scope.get(Tokens.RepoCollaboratorDAO)();
      const rows = await collabDao.listByRepo(repo.id);
      return c.json({ collaborators: rows.map((r) => ({ email: r.user_email, role: r.role })) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
  });

  app.put('/user/repos/:owner/:repo/collaborators/:member', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const member = decodeURIComponent(c.req.param('member'));
    const body = (await c.req.json().catch(() => ({}))) as { role?: string };
    const role = body.role ?? 'read';
    if (role !== 'admin' && role !== 'write' && role !== 'read') return c.json({ error: 'Invalid role' }, 400);
    try {
      const scope = createRequestScope(c.env);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const targetEmail = member.includes('@') ? member.toLowerCase() : await scope.get(Tokens.OrganizationService).resolveEmail(member);
      const now = Math.floor(Date.now() / 1000);
      const collabDao = await scope.get(Tokens.RepoCollaboratorDAO)();
      await collabDao.upsert(repo.id, targetEmail, role, email, now);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed' }, toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/collaborators/:member', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const member = decodeURIComponent(c.req.param('member'));
    try {
      const scope = createRequestScope(c.env);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const targetEmail = member.includes('@') ? member.toLowerCase() : await scope.get(Tokens.OrganizationService).resolveEmail(member);
      const collabDao = await scope.get(Tokens.RepoCollaboratorDAO)();
      await collabDao.remove(repo.id, targetEmail);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed' }, toServiceStatus(error));
    }
  });
}

export { registerOrgRoutes };
