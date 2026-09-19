import { jsonError, withPublicRepo } from '../PublicViewerResolver';
import { toSafeErrorMessage, toServiceStatus } from '../PublicViewerResolver';
import { requireVisibleRepo } from '../PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { needAdmin, resolveRepoRow } from './CollabHelpers';
import type { CollabApp } from './CollabHelpers';
import { readJsonBody } from '../BodyParser';

function registerCollabLabelPublicRoutes(app: CollabApp): void {
  app.get('/repos/:owner/:repo/labels', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      try {
        const labels = await createRequestScope(c.env).get(Tokens.CollaborationService).listLabels(row.id);
        return c.json({ labels });
      } catch {
        return c.json({ labels: [] });
      }
    });
  });
}

function registerCollabLabelUserRoutes(app: CollabApp): void {
  app.get('/user/repos/:owner/:repo/labels', async (c) => {
    const found = await resolveRepoRow(c.env, c.req.param('owner'), c.req.param('repo'), c.get('AuthenticatedUserEmailAddress'));
    if (!found) return jsonError(c, 'Not found', 404);
    try {
      const labels = await createRequestScope(c.env).get(Tokens.CollaborationService).listLabels(found.row.id);
      return c.json({ labels });
    } catch {
      return c.json({ labels: [] });
    }
  });

  app.post('/user/repos/:owner/:repo/labels', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await needAdmin(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const { malformed, body } = await readJsonBody<{ name?: string; color?: string; description?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const created = await createRequestScope(c.env)
        .get(Tokens.CollaborationService)
        .createLabel(row.id, body as { name: string });
      return c.json(created, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create label'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/labels/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await needAdmin(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    try {
      await createRequestScope(c.env).get(Tokens.CollaborationService).deleteLabel(row.id, c.req.param('id'));
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });
}

export { registerCollabLabelPublicRoutes, registerCollabLabelUserRoutes };
