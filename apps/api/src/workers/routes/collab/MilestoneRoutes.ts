import { jsonError, withPublicRepo } from '../PublicViewerResolver';
import { toSafeErrorMessage, toServiceStatus } from '../PublicViewerResolver';
import { requireVisibleRepo } from '../PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { needWrite, resolveRepoRow } from './CollabHelpers';
import type { CollabApp } from './CollabHelpers';
import { readJsonBody } from '../BodyParser';

function registerCollabMilestonePublicRoutes(app: CollabApp): void {
  app.get('/repos/:owner/:repo/milestones', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      try {
        const milestones = await createRequestScope(c.env).get(Tokens.CollaborationService).listMilestones(row.id);
        return c.json({ milestones });
      } catch {
        return c.json({ milestones: [] });
      }
    });
  });
}

function registerCollabMilestoneUserRoutes(app: CollabApp): void {
  app.get('/user/repos/:owner/:repo/milestones', async (c) => {
    const found = await resolveRepoRow(c.env, c.req.param('owner'), c.req.param('repo'), c.get('AuthenticatedUserEmailAddress'));
    if (!found) return jsonError(c, 'Not found', 404);
    try {
      const milestones = await createRequestScope(c.env).get(Tokens.CollaborationService).listMilestones(found.row.id);
      return c.json({ milestones });
    } catch {
      return c.json({ milestones: [] });
    }
  });

  app.post('/user/repos/:owner/:repo/milestones', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const { malformed, body } = await readJsonBody<{ title?: string; description?: string; dueOn?: number }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (!body.title?.trim()) return jsonError(c, 'title is required', 400);
    try {
      const created = await createRequestScope(c.env)
        .get(Tokens.CollaborationService)
        .createMilestone(row.id, body as { title: string });
      return c.json(created, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create milestone'), toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/milestones/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const { malformed, body } = await readJsonBody<{ status?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      await createRequestScope(c.env).get(Tokens.CollaborationService).updateMilestone(row.id, c.req.param('id'), body);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update milestone'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/milestones/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    try {
      await createRequestScope(c.env).get(Tokens.CollaborationService).deleteMilestone(row.id, c.req.param('id'));
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });
}

export { registerCollabMilestonePublicRoutes, registerCollabMilestoneUserRoutes };
