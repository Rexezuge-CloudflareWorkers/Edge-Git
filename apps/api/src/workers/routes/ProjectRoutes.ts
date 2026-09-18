import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { parsePositiveInt } from '@edge-git/shared/validation';
import { recordAndNotify } from './SocialEmit';
import { requireVisibleRepo, toSafeErrorMessage, toServiceStatus, withPublicRepo } from './PublicViewerResolver';

type ProjectApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function parseProjectNumber(raw: string | undefined): number | null {
  return parsePositiveInt(raw ?? null);
}

function registerProjectPublicRoutes(app: ProjectApp): void {
  app.get('/repos/:owner/:repo/projects', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      try {
        const projects = await createRequestScope(c.env).get(Tokens.ProjectService).listProjects(row.id);
        return c.json({ projects });
      } catch {
        return c.json({ projects: [] });
      }
    });
  });

  app.get('/repos/:owner/:repo/projects/:number', async (c) => {
    return withPublicRepo(c as never, async (row) => {
      const number = parseProjectNumber(c.req.param('number'));
      if (number === null) return c.json({ error: 'Invalid project number' }, 400);
      try {
        const board = await createRequestScope(c.env).get(Tokens.ProjectService).getProjectBoard(row.id, number);
        return c.json(board);
      } catch (error) {
        return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
      }
    });
  });
}

function registerProjectUserRoutes(app: ProjectApp): void {
  app.get('/user/repos/:owner/:repo/projects', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const row = await requireVisibleRepo(c.env, c.req.param('owner'), RepoService.normalizeRepo(c.req.param('repo')), email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      const projects = await createRequestScope(c.env).get(Tokens.ProjectService).listProjects(row.id);
      return c.json({ projects });
    } catch {
      return c.json({ projects: [] });
    }
  });

  app.post('/user/repos/:owner/:repo/projects', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const body = (await c.req.json().catch(() => ({}))) as { title: unknown; description?: unknown };
    try {
      const scope = createRequestScope(c.env);
      const project = await scope.get(Tokens.ProjectService).createProject(row.id, body, email);
      void recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName: `${row.owner}/${row.name}`,
        actorEmail: email,
        type: 'project_created',
        title: `Project ${project.title} created`,
        subjectType: 'project',
        subjectNumber: project.number,
        payload: { number: project.number, title: project.title },
      });
      return c.json({ project }, 201);
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed to create project') }, toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/projects/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const row = await requireVisibleRepo(c.env, c.req.param('owner'), RepoService.normalizeRepo(c.req.param('repo')), email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Invalid project number' }, 400);
    try {
      const board = await createRequestScope(c.env).get(Tokens.ProjectService).getProjectBoard(row.id, number);
      return c.json(board);
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/projects/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Invalid project number' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown; description?: unknown; status?: unknown };
    try {
      const scope = createRequestScope(c.env);
      const project =
        body.status === undefined
          ? await scope.get(Tokens.ProjectService).updateProject(row.id, number, body)
          : await scope.get(Tokens.ProjectService).setStatus(row.id, number, body.status);
      if (project.status === 'closed') {
        void recordAndNotify(c.env, {
          repositoryId: row.id,
          fullName: `${row.owner}/${row.name}`,
          actorEmail: email,
          type: 'project_closed',
          title: `Project ${project.title} closed`,
          subjectType: 'project',
          subjectNumber: project.number,
          payload: { number: project.number },
        });
      }
      return c.json({ project });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed to update project') }, toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/projects/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Invalid project number' }, 400);
    try {
      await createRequestScope(c.env).get(Tokens.ProjectService).deleteProject(row.id, number);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/projects/:number/columns', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Invalid project number' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
    try {
      const column = await createRequestScope(c.env)
        .get(Tokens.ProjectService)
        .createColumn(row.id, number, body as { title: unknown });
      return c.json({ column }, 201);
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed to create column') }, toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/projects/:number/columns/:columnId', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Invalid project number' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
    try {
      const column = await createRequestScope(c.env)
        .get(Tokens.ProjectService)
        .renameColumn(row.id, number, c.req.param('columnId'), body as { title: unknown });
      return c.json({ column });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed to rename column') }, toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/projects/:number/columns/:columnId', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Invalid project number' }, 400);
    try {
      await createRequestScope(c.env).get(Tokens.ProjectService).deleteColumn(row.id, number, c.req.param('columnId'));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/projects/:number/cards', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Invalid project number' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
      columnId: unknown;
      kind?: unknown;
      noteTitle?: unknown;
      noteBody?: unknown;
      issueId?: unknown;
      pullRequestId?: unknown;
    };
    try {
      const card = await createRequestScope(c.env).get(Tokens.ProjectService).createCard(row.id, number, body, email);
      return c.json({ card }, 201);
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed to create card') }, toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/projects/:number/cards/:cardId/move', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Invalid project number' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { toColumnId: unknown; position?: unknown };
    try {
      const card = await createRequestScope(c.env).get(Tokens.ProjectService).moveCard(row.id, number, c.req.param('cardId'), body);
      return c.json({ card });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed to move card') }, toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/projects/:number/cards/:cardId', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Invalid project number' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { archived?: unknown };
    try {
      const card = await createRequestScope(c.env)
        .get(Tokens.ProjectService)
        .setCardArchived(row.id, number, c.req.param('cardId'), body.archived);
      return c.json({ card });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed to update card') }, toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/projects/:number/cards/:cardId', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Invalid project number' }, 400);
    try {
      await createRequestScope(c.env).get(Tokens.ProjectService).deleteCard(row.id, number, c.req.param('cardId'));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
    }
  });
}

export { registerProjectPublicRoutes, registerProjectUserRoutes };
export type { ProjectApp };
