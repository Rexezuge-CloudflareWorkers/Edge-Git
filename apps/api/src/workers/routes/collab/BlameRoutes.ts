import { jsonError, toSafeErrorMessage, withPublicRepo } from '../PublicViewerResolver';
import { requireVisibleRepo } from '../PublicViewerResolver';
import { RepoService } from '@edge-git/backend-services/repo';
import { getRepoStub } from '../../repoStub';
import type { CollabApp } from './CollabHelpers';

function registerCollabBlamePublicRoutes(app: CollabApp): void {
  app.get('/repos/:owner/:repo/blame', async (c) => {
    return withPublicRepo(c, async (_row, fullName) => {
      const ref = c.req.query('ref') || 'HEAD';
      const path = c.req.query('path') || '';
      if (!path) return jsonError(c, 'path is required', 400);
      try {
        const blame = await getRepoStub(c.env, fullName).getBlame({ ref, filepath: path });
        if (!blame) return jsonError(c, 'Not found', 404);
        return c.json({ blame });
      } catch (error) {
        return jsonError(c, toSafeErrorMessage(error, 'Failed to load blame'), 500);
      }
    });
  });
}

function registerCollabBlameUserRoutes(app: CollabApp): void {
  app.get('/user/repos/:owner/:repo/blame', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return jsonError(c, 'Not found', 404);
    const ref = c.req.query('ref') || 'HEAD';
    const path = c.req.query('path') || '';
    if (!path) return jsonError(c, 'path is required', 400);
    try {
      const blame = await getRepoStub(c.env, `${owner}/${repoName}`).getBlame({ ref, filepath: path });
      if (!blame) return jsonError(c, 'Not found', 404);
      return c.json({ blame });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to load blame'), 500);
    }
  });
}

export { registerCollabBlamePublicRoutes, registerCollabBlameUserRoutes };
