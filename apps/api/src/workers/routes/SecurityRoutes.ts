import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { SecuritySettingsService } from '@edge-git/backend-services/security';
import { toSafeErrorMessage, toServiceStatus } from './PublicViewerResolver';

type SecurityApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

// Per-repo security settings. Secret scanning is warn-by-default: pushes
// and web saves go through with an `X-EdgeGit-Secret-Warning` flag.
// `block` rejects the whole push pre-receive style; `off` disables.
function registerSecurityRoutes(app: SecurityApp): void {
  app.get('/user/repos/:owner/:repo/security', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    try {
      const scope = createRequestScope(c.env);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'read');
      const settings = await scope.get(Tokens.SecuritySettingsService).getSettings(repo.id);
      return c.json({ settings });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed to load security settings') }, toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/security', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const body = (await c.req.json().catch(() => ({}))) as { secretScanMode?: unknown };
    if (body.secretScanMode === undefined) return c.json({ error: 'secretScanMode is required' }, 400);
    try {
      const mode = SecuritySettingsService.normalizeMode(body.secretScanMode);
      const scope = createRequestScope(c.env);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const settings = await scope.get(Tokens.SecuritySettingsService).setMode(repo.id, mode, email);
      return c.json({ settings });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed to update security settings') }, toServiceStatus(error));
    }
  });
}

export { registerSecurityRoutes };
