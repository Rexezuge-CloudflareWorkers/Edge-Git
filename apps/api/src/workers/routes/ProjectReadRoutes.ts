import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import { jsonError, requireVisibleRepo, toSafeErrorMessage, toServiceStatus, withPublicRepo } from './PublicViewerResolver';
import { parseProjectNumber } from './ProjectRouteParsers';
import type { ProjectApp } from './ProjectRouteParsers';
import { presentMany, presentSingle } from './IdentityPresenter';

function registerProjectPublicRoutes(app: ProjectApp): void {
  app.get('/repos/:owner/:repo/projects', async (c) => {
    return withPublicRepo(c, async (row) => {
      try {
        const scope = createRequestScope(c.env);
        const projects = await scope.get(Tokens.ProjectService).listProjects(row.id);
        return c.json({ projects: await presentMany(scope, projects) });
      } catch {
        return c.json({ projects: [] });
      }
    });
  });

  app.get('/repos/:owner/:repo/projects/:number', async (c) => {
    return withPublicRepo(c, async (row) => {
      const number = parseProjectNumber(c.req.param('number'));
      if (number === null) return jsonError(c, 'Invalid project number', 400);
      try {
        const scope = createRequestScope(c.env);
        const board = await scope.get(Tokens.ProjectService).getProjectBoard(row.id, number);
        return c.json({
          project: await presentSingle(scope, board.project),
          columns: board.columns,
          cards: await presentMany(scope, board.cards),
        });
      } catch (error) {
        return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
      }
    });
  });
}

function registerProjectUserReadRoutes(app: ProjectApp): void {
  app.get('/user/repos/:owner/:repo/projects', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const row = await requireVisibleRepo(c.env, c.req.param('owner'), RepoFullName.normalizeRepo(c.req.param('repo')), email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      const scope = createRequestScope(c.env);
      const projects = await scope.get(Tokens.ProjectService).listProjects(row.id);
      return c.json({ projects: await presentMany(scope, projects) });
    } catch {
      return c.json({ projects: [] });
    }
  });

  app.get('/user/repos/:owner/:repo/projects/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const row = await requireVisibleRepo(c.env, c.req.param('owner'), RepoFullName.normalizeRepo(c.req.param('repo')), email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid project number', 400);
    try {
      const scope = createRequestScope(c.env);
      const board = await scope.get(Tokens.ProjectService).getProjectBoard(row.id, number);
      return c.json({
        project: await presentSingle(scope, board.project),
        columns: board.columns,
        cards: await presentMany(scope, board.cards),
      });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });
}

export { registerProjectPublicRoutes, registerProjectUserReadRoutes };
