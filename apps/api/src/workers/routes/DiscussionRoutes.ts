import type { Hono } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import { presentMany, presentSingle } from './IdentityPresenter';
import { RepoFullName } from '@edge-git/shared/utils';
import { parsePositiveInt } from '@edge-git/shared/validation';
import { recordAndNotify } from './SocialEmit';
import { jsonError, requireVisibleRepo, toSafeErrorMessage, toServiceStatus, withPublicRepo, getScope } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';

type DiscussionApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function parseNumber(raw: string | undefined): number | null {
  return parsePositiveInt(raw ?? null);
}

function registerDiscussionPublicRoutes(app: DiscussionApp): void {
  app.get('/repos/:owner/:repo/discussions/categories', async (c) => {
    return withPublicRepo(c, async (row) => {
      try {
        const categories = await getScope(c).get(Tokens.DiscussionService).listCategories(row.id);
        return c.json({ categories });
      } catch {
        return c.json({ categories: [] });
      }
    });
  });

  app.get('/repos/:owner/:repo/discussions', async (c) => {
    return withPublicRepo(c, async (row) => {
      try {
        const url = new URL(c.req.url);
        const scope = getScope(c);
        const discussions = await scope
          .get(Tokens.DiscussionService)
          .listDiscussions(row.id, url.searchParams.get('category') ?? undefined);
        return c.json({ discussions: await presentMany(scope, discussions) });
      } catch {
        return c.json({ discussions: [] });
      }
    });
  });

  app.get('/repos/:owner/:repo/discussions/:number', async (c) => {
    return withPublicRepo(c, async (row) => {
      const number = parseNumber(c.req.param('number'));
      if (number === null) return jsonError(c, 'Invalid discussion number', 400);
      try {
        const scope = getScope(c);
        const result = await scope.get(Tokens.DiscussionService).getDiscussionWithComments(row.id, number);
        return c.json({ discussion: await presentSingle(scope, result.discussion), comments: await presentMany(scope, result.comments) });
      } catch (error) {
        return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
      }
    });
  });
}

function registerDiscussionUserRoutes(app: DiscussionApp): void {
  app.get('/user/repos/:owner/:repo/discussions/categories', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const row = await requireVisibleRepo(c.env, c.req.param('owner'), RepoFullName.normalizeRepo(c.req.param('repo')), email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      const categories = await getScope(c).get(Tokens.DiscussionService).listCategories(row.id);
      return c.json({ categories });
    } catch {
      return c.json({ categories: [] });
    }
  });

  app.get('/user/repos/:owner/:repo/discussions', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const row = await requireVisibleRepo(c.env, c.req.param('owner'), RepoFullName.normalizeRepo(c.req.param('repo')), email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      const url = new URL(c.req.url);
      const scope = getScope(c);
      const discussions = await scope.get(Tokens.DiscussionService).listDiscussions(row.id, url.searchParams.get('category') ?? undefined);
      return c.json({ discussions: await presentMany(scope, discussions) });
    } catch {
      return c.json({ discussions: [] });
    }
  });

  app.post('/user/repos/:owner/:repo/discussions', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const row = await requireVisibleRepo(c.env, c.req.param('owner'), RepoFullName.normalizeRepo(c.req.param('repo')), email);
    if (!row) return jsonError(c, 'Not found', 404);
    const { malformed, oversized, body } = await readJsonBody<{ title: unknown; body?: unknown; categorySlug?: unknown }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
      const discussion = await scope.get(Tokens.DiscussionService).createDiscussion(row.id, body, email);
      void recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName: `${row.owner}/${row.name}`,
        actorEmail: email,
        type: 'discussion_opened',
        title: `Discussion ${discussion.title} opened`,
        subjectType: 'discussion',
        subjectNumber: discussion.number,
        mentionText: typeof body.body === 'string' ? body.body : null,
        payload: { number: discussion.number, title: discussion.title },
      });
      return c.json({ discussion: await presentSingle(scope, discussion) }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create discussion'), toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/discussions/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const row = await requireVisibleRepo(c.env, c.req.param('owner'), RepoFullName.normalizeRepo(c.req.param('repo')), email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid discussion number', 400);
    try {
      const scope = getScope(c);
      const result = await scope.get(Tokens.DiscussionService).getDiscussionWithComments(row.id, number);
      return c.json({ discussion: await presentSingle(scope, result.discussion), comments: await presentMany(scope, result.comments) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/discussions/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid discussion number', 400);
    const { malformed, oversized, body } = await readJsonBody<{
      title?: unknown;
      body?: unknown;
      categorySlug?: unknown;
      status?: unknown;
    }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
      const svc = scope.get(Tokens.DiscussionService);
      const before = await svc.getDiscussion(row.id, number);
      const isAuthor = before.authorEmail.toLowerCase() === email.toLowerCase();
      let isWriter = false;
      try {
        await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
        isWriter = true;
      } catch {
        isWriter = false;
      }
      // Status transitions (lock/answer) need write+; content edits need author or write+.
      if (!isWriter && body.status !== undefined) return jsonError(c, 'Forbidden', 403);
      if (!isAuthor && !isWriter && (body.title !== undefined || body.body !== undefined || body.categorySlug !== undefined))
        return jsonError(c, 'Forbidden', 403);
      const discussion =
        body.status === undefined
          ? await svc.updateDiscussion(row.id, number, { title: body.title, body: body.body, categorySlug: body.categorySlug })
          : await svc.setStatus(row.id, number, body.status);
      if (body.status === 'answered' || body.status === 'locked') {
        void recordAndNotify(c.env, {
          repositoryId: row.id,
          fullName: `${row.owner}/${row.name}`,
          actorEmail: email,
          type: body.status === 'answered' ? 'discussion_answered' : 'discussion_locked',
          title: `Discussion ${discussion.title} ${body.status}`,
          subjectType: 'discussion',
          subjectNumber: discussion.number,
          payload: { number: discussion.number, status: body.status },
        });
      }
      return c.json({ discussion: await presentSingle(scope, discussion) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update discussion'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/discussions/:number', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid discussion number', 400);
    try {
      const scope = getScope(c);
      const before = await scope.get(Tokens.DiscussionService).getDiscussion(row.id, number);
      const isAuthor = before.authorEmail.toLowerCase() === email.toLowerCase();
      try {
        await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
      } catch {
        if (!isAuthor) return jsonError(c, 'Forbidden', 403);
      }
      await scope.get(Tokens.DiscussionService).deleteDiscussion(row.id, number);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/discussions/:number/comments', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const row = await requireVisibleRepo(c.env, c.req.param('owner'), RepoFullName.normalizeRepo(c.req.param('repo')), email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid discussion number', 400);
    const { malformed, oversized, body } = await readJsonBody<{ body?: unknown }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
      const comment = await scope.get(Tokens.DiscussionService).addComment(row.id, number, body as { body: unknown }, email);
      void recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName: `${row.owner}/${row.name}`,
        actorEmail: email,
        type: 'discussion_commented',
        title: `Comment on discussion #${number}`,
        subjectType: 'discussion',
        subjectNumber: number,
        mentionText: typeof body.body === 'string' ? body.body : null,
        payload: { number },
      });
      return c.json({ comment: await presentSingle(scope, comment) }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to add comment'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/discussions/:number/comments/:commentId', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Invalid discussion number', 400);
    try {
      const scope = getScope(c);
      try {
        await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
      } catch {
        // Non-writers can only delete via service-level check below; fall through
        // and let NotFound/ownership surface as 403 to avoid leaking existence.
      }
      await scope.get(Tokens.DiscussionService).deleteComment(row.id, number, c.req.param('commentId'));
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });
}

export { registerDiscussionPublicRoutes, registerDiscussionUserRoutes };
export type { DiscussionApp };
