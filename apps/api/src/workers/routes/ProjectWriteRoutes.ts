import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { recordAndNotify } from './SocialEmit';
import { jsonError, requireVisibleRepo, toSafeErrorMessage, toServiceStatus } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';
import { parseProjectNumber } from './ProjectRouteParsers';
import type { ProjectApp } from './ProjectRouteParsers';

async function requireWriteRole(env: Env, owner: string, repoName: string, email: string): Promise<boolean> {
  try {
    await createRequestScope(env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    return true;
  } catch {
    return false;
  }
}

function registerProjectUserWriteRoutes(app: ProjectApp): void {
  app.post('/user/repos/:owner/:repo/projects', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await requireWriteRole(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const { malformed, body } = await readJsonBody<{ title: unknown; description?: unknown }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
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
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create project'), toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/projects/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await requireWriteRole(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid project number', 400);
    const { malformed, body } = await readJsonBody<{ title?: unknown; description?: unknown; status?: unknown }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
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
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update project'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/projects/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await requireWriteRole(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid project number', 400);
    try {
      await createRequestScope(c.env).get(Tokens.ProjectService).deleteProject(row.id, number);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/projects/:number/columns', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await requireWriteRole(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid project number', 400);
    const { malformed, body } = await readJsonBody<{ title?: unknown }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const column = await createRequestScope(c.env)
        .get(Tokens.ProjectService)
        .createColumn(row.id, number, body as { title: unknown });
      return c.json({ column }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create column'), toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/projects/:number/columns/:columnId', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await requireWriteRole(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid project number', 400);
    const { malformed, body } = await readJsonBody<{ title?: unknown }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const column = await createRequestScope(c.env)
        .get(Tokens.ProjectService)
        .renameColumn(row.id, number, c.req.param('columnId'), body as { title: unknown });
      return c.json({ column });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to rename column'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/projects/:number/columns/:columnId', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await requireWriteRole(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid project number', 400);
    try {
      await createRequestScope(c.env).get(Tokens.ProjectService).deleteColumn(row.id, number, c.req.param('columnId'));
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/projects/:number/cards', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await requireWriteRole(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid project number', 400);
    const { malformed, body } = await readJsonBody<{
      columnId: unknown;
      kind?: unknown;
      noteTitle?: unknown;
      noteBody?: unknown;
      issueId?: unknown;
      pullRequestId?: unknown;
    }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const card = await createRequestScope(c.env).get(Tokens.ProjectService).createCard(row.id, number, body, email);
      return c.json({ card }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create card'), toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/projects/:number/cards/:cardId/move', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await requireWriteRole(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid project number', 400);
    const { malformed, body } = await readJsonBody<{ toColumnId: unknown; position?: unknown }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const card = await createRequestScope(c.env).get(Tokens.ProjectService).moveCard(row.id, number, c.req.param('cardId'), body);
      return c.json({ card });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to move card'), toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/projects/:number/cards/:cardId', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await requireWriteRole(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid project number', 400);
    const { malformed, body } = await readJsonBody<{ archived?: unknown }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const card = await createRequestScope(c.env)
        .get(Tokens.ProjectService)
        .setCardArchived(row.id, number, c.req.param('cardId'), body.archived);
      return c.json({ card });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update card'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/projects/:number/cards/:cardId', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await requireWriteRole(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const number = parseProjectNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid project number', 400);
    try {
      await createRequestScope(c.env).get(Tokens.ProjectService).deleteCard(row.id, number, c.req.param('cardId'));
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });
}

export { registerProjectUserWriteRoutes };
