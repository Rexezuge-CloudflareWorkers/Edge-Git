import type { Hono } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import { SecuritySettingsService } from '@edge-git/backend-services/security';
import { jsonError, toSafeErrorMessage, toServiceStatus, getScope } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';

type SecurityApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

// Per-repo security settings. Secret scanning is warn-by-default: pushes
// and web saves go through with an `X-EdgeGit-Secret-Warning` flag.
// `block` rejects the whole push pre-receive style; `off` disables.
function registerSecurityRoutes(app: SecurityApp): void {
  app.get('/user/repos/:owner/:repo/security', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'read');
      const settings = await scope.get(Tokens.SecuritySettingsService).getSettings(repo.id);
      return c.json({ settings });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to load security settings'), toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/security', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const { malformed, body } = await readJsonBody<{ secretScanMode?: unknown }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (body.secretScanMode === undefined) return jsonError(c, 'secretScanMode is required', 400);
    try {
      const mode = SecuritySettingsService.normalizeMode(body.secretScanMode);
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const settings = await scope.get(Tokens.SecuritySettingsService).setMode(repo.id, mode, email);
      return c.json({ settings });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update security settings'), toServiceStatus(error));
    }
  });
}

export { registerSecurityRoutes };
