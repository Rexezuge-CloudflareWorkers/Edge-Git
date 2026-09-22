import type { Hono } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import { usernameFor, usernameMap } from './IdentityPresenter';
import { RepoFullName } from '@edge-git/shared/utils';
import { jsonError, toSafeErrorMessage, toServiceStatus, getScope } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';

type OrgApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function registerOrgRoutes(app: OrgApp): void {
  app.post('/user/orgs', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, body } = await readJsonBody<{ username?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (!body.username) return jsonError(c, 'username is required', 400);
    try {
      const org = await getScope(c).get(Tokens.OrganizationService).createOrganization(email, body.username);
      return c.json({ id: org.id, username: org.username }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create organization';
      const status =
        message.includes('taken') || message.includes('Invalid') || message.includes('reserved') ? 400 : toServiceStatus(error);
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create organization'), status);
    }
  });

  app.get('/user/orgs', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const orgs = await getScope(c).get(Tokens.OrganizationService).listOrgsForUser(email);
    return c.json({ orgs: orgs.map((o) => ({ id: o.id, username: o.username })) });
  });

  app.get('/user/orgs/:org', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const orgName = c.req.param('org');
    try {
      const scope = getScope(c);
      const org = await scope.get(Tokens.OrganizationService).requireMember(orgName, email);
      const members = await scope.get(Tokens.OrganizationService).listMembers(org.username, email);
      const viewerRole = await scope
        .get(Tokens.OrganizationService)
        .getMemberRole(org.id, email)
        .catch(() => null);
      return c.json({ id: org.id, username: org.username, members, viewerRole });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.patch('/user/orgs/:org', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const orgName = c.req.param('org');
    const { malformed, body } = await readJsonBody<{ username?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
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
          remember(
            await scope
              .get(Tokens.RepositoryDAO)()
              .then((dao) => dao.listByOrgId(org.id, 1000)),
          );
        } catch {
          // ignore — owner snapshot below still applies
        }
        try {
          remember(
            await scope
              .get(Tokens.RepositoryDAO)()
              .then((dao) => dao.listByOwner(before, 1000)),
          );
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
                return jsonError(c, moveError instanceof Error ? moveError.message : 'Repository too large to move', 413);
              }
              return jsonError(c, 'Failed to move repository data', 500);
            }
          }
        }
      }
      return c.json({ id: org.id, username: org.username });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update organization';
      const status =
        message.includes('taken') || message.includes('Invalid') || message.includes('reserved') ? 400 : toServiceStatus(error);
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update organization'), status);
    }
  });

  app.delete('/user/orgs/:org', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      await getScope(c).get(Tokens.OrganizationService).disband(c.req.param('org'), email);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });

  app.get('/user/orgs/:org/members', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const members = await getScope(c).get(Tokens.OrganizationService).listMembers(c.req.param('org'), email);
      return c.json({ members });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.post('/user/orgs/:org/members', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, body } = await readJsonBody<{ username?: string; email?: string; role?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    const target = body.username ?? body.email;
    if (!target) return jsonError(c, 'username or email is required', 400);
    const role = body.role ?? 'member';
    if (role !== 'owner' && role !== 'member') return jsonError(c, 'Invalid role', 400);
    try {
      await getScope(c).get(Tokens.OrganizationService).addMember(c.req.param('org'), email, target, role);
      return c.json({ ok: true }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });

  app.patch('/user/orgs/:org/members/:member', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, body } = await readJsonBody<{ role?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (body.role !== 'owner' && body.role !== 'member') return jsonError(c, 'Invalid role', 400);
    try {
      await getScope(c)
        .get(Tokens.OrganizationService)
        .setMemberRole(c.req.param('org'), email, decodeURIComponent(c.req.param('member')), body.role);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });

  app.delete('/user/orgs/:org/members/:member', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      await getScope(c)
        .get(Tokens.OrganizationService)
        .removeMember(c.req.param('org'), email, decodeURIComponent(c.req.param('member')));
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });

  // Collaborators: admin-only per repo.
  app.get('/user/repos/:owner/:repo/collaborators', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    try {
      const scope = getScope(c);
      await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const repo = await scope.get(Tokens.RepoService).getByOwnerAndName(owner, repoName);
      if (!repo) return jsonError(c, 'Not found', 404);
      const collabDao = await scope.get(Tokens.RepoCollaboratorDAO)();
      const rows = await collabDao.listByRepo(repo.id);
      const map = await usernameMap(
        scope,
        rows.map((r) => r.user_email),
      );
      return c.json({ collaborators: rows.map((r) => ({ username: usernameFor(map, r.user_email), role: r.role })) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.put('/user/repos/:owner/:repo/collaborators/:member', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const member = decodeURIComponent(c.req.param('member'));
    const { malformed, body } = await readJsonBody<{ role?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    const role = body.role ?? 'read';
    if (role !== 'admin' && role !== 'write' && role !== 'read') return jsonError(c, 'Invalid role', 400);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const targetEmail = member.includes('@') ? member.toLowerCase() : await scope.get(Tokens.OrganizationService).resolveEmail(member);
      const now = Math.floor(Date.now() / 1000);
      const collabDao = await scope.get(Tokens.RepoCollaboratorDAO)();
      await collabDao.upsert(repo.id, targetEmail, role, email, now);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/collaborators/:member', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const member = decodeURIComponent(c.req.param('member'));
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const targetEmail = member.includes('@') ? member.toLowerCase() : await scope.get(Tokens.OrganizationService).resolveEmail(member);
      const collabDao = await scope.get(Tokens.RepoCollaboratorDAO)();
      await collabDao.remove(repo.id, targetEmail);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });
}

export { registerOrgRoutes };
