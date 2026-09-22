import type { Hono } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import { presentMany, presentSingle } from './IdentityPresenter';
import { DeployKeyService } from '@edge-git/backend-services/deploykey';
import { RepoFullName } from '@edge-git/shared/utils';
import { jsonError, toSafeErrorMessage, toServiceStatus, getScope } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';

type DeployKeyApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

// Deploy keys: per-repo git-only credentials (`read` default, optional
// `write`). Secrets are shown once at creation; lists expose only the
// prefix. Manageable by repo `admin`s.
function registerDeployKeyRoutes(app: DeployKeyApp): void {
  app.get('/user/repos/:owner/:repo/keys', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const keys = await scope.get(Tokens.DeployKeyService).listKeys(repo.id);
      return c.json({ keys: await presentMany(scope, keys) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to list deploy keys'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/keys', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const { malformed, body } = await readJsonBody<{ name?: string; permission?: unknown; expiresInDays?: number }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.name !== 'string' || !body.name.trim()) return jsonError(c, 'name is required', 400);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const created = await scope
        .get(Tokens.DeployKeyService)
        .createKey(repo.id, body.name, DeployKeyService.normalizePermission(body.permission), email, body.expiresInDays);
      return c.json(await presentSingle(scope, created), 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create deploy key'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/keys/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      await scope.get(Tokens.DeployKeyService).revokeKey(repo.id, c.req.param('id'));
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to revoke deploy key'), toServiceStatus(error));
    }
  });
}

export { registerDeployKeyRoutes };
