import type { Hono } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import { jsonError, toSafeErrorMessage, toServiceStatus, getScope } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';

type RuleApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

// Branch protection rules — list needs `read+`, create/delete need `admin`.
// Rules apply to everyone including admins: to push directly to a protected
// branch, delete the rule first (or open a pull request).
function registerRuleRoutes(app: RuleApp): void {
  app.get('/user/repos/:owner/:repo/rules', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'read');
      const rules = await scope.get(Tokens.BranchProtectionService).listRules(repo.id);
      return c.json({ rules });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to list rules'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/rules', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const { malformed, body } = await readJsonBody<{
      pattern?: string;
      requirePr?: boolean;
      requiredApprovals?: number;
      blockForcePush?: boolean;
      blockDeletion?: boolean;
      requireStatusChecks?: unknown;
    }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.pattern !== 'string' || !body.pattern.trim()) return jsonError(c, 'pattern is required', 400);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const rule = await scope.get(Tokens.BranchProtectionService).createRule({
        repositoryId: repo.id,
        pattern: body.pattern,
        requirePr: body.requirePr,
        requiredApprovals: body.requiredApprovals,
        blockForcePush: body.blockForcePush,
        blockDeletion: body.blockDeletion,
        requireStatusChecks: body.requireStatusChecks,
        createdBy: email,
      });
      return c.json({ rule }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create rule'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/rules/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const id = c.req.param('id');
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      await scope.get(Tokens.BranchProtectionService).deleteRule(repo.id, id);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to delete rule'), toServiceStatus(error));
    }
  });
}

export { registerRuleRoutes };
