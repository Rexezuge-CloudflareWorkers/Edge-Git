import type { Hono } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import { presentMany, presentSingle } from './IdentityPresenter';
import type { AccessIdentityContext } from '@edge-git/backend-services/auth';
import { emitWebhookEvent } from './SocialEmit';
import { jsonError, toSafeErrorMessage, toServiceStatus, getScope } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';
import { parseLimitParam } from './RouteInput';

type SnippetApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function registerSnippetPublicRoutes(app: SnippetApp): void {
  app.get('/snippets/public', async (c) => {
    try {
      const url = new URL(c.req.url);
      const limit = parseLimitParam(url.searchParams.get('limit'), 20, 50);
      const scope = getScope(c);
      const snippets = await scope.get(Tokens.SnippetService).listPublic(limit);
      return c.json({ snippets: await presentMany(scope, snippets) });
    } catch {
      return c.json({ snippets: [] });
    }
  });

  app.get('/snippets/:id', async (c) => {
    try {
      // Public fetch: secret rows 404 unless the viewer owns them and passes
      // their identity via Access/PAT (best-effort, never throws).
      let viewerEmail: string | null = null;
      try {
        viewerEmail = await getScope(c)
          .get(Tokens.AccessAuthService)
          .getAuthenticatedUserEmail(c.req.raw, c.executionCtx as unknown as AccessIdentityContext);
      } catch {
        viewerEmail = null;
      }
      const scope = getScope(c);
      const result = await scope.get(Tokens.SnippetService).getSnippet(c.req.param('id'), viewerEmail);
      return c.json({ snippet: await presentSingle(scope, result.snippet), files: result.files });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.get('/users/:username/snippets', async (c) => {
    try {
      const username = c.req.param('username');
      const user = await getScope(c).get(Tokens.UserService).getByUsername(username);
      if (!user) return jsonError(c, 'Not found', 404);
      let viewerEmail: string | null = null;
      try {
        viewerEmail = await getScope(c)
          .get(Tokens.AccessAuthService)
          .getAuthenticatedUserEmail(c.req.raw, c.executionCtx as unknown as AccessIdentityContext);
      } catch {
        viewerEmail = null;
      }
      const scope = getScope(c);
      const snippets = await scope.get(Tokens.SnippetService).listByOwner(user.email, viewerEmail);
      return c.json({ snippets: await presentMany(scope, snippets) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });
}

function registerSnippetUserRoutes(app: SnippetApp): void {
  app.get('/user/snippets', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const scope = getScope(c);
      const snippets = await scope.get(Tokens.SnippetService).listByOwner(email, email);
      return c.json({ snippets: await presentMany(scope, snippets) });
    } catch {
      return c.json({ snippets: [] });
    }
  });

  app.post('/user/snippets', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, oversized, body } = await readJsonBody<{ title?: unknown; visibility?: unknown; files?: unknown }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
      const result = await scope
        .get(Tokens.SnippetService)
        .createSnippet(email, { title: body.title, visibility: body.visibility, files: body.files });
      // Snippets are user-scoped: no repo_events row, only a webhook ping for
      // hooks parity (repositoryId empty is skipped by enqueue, best-effort).
      void emitWebhookEvent(c.env, {
        repositoryId: '',
        fullName: '',
        actorEmail: email,
        event: 'snippet',
        title: `Snippet ${result.snippet.id} created`,
        subjectType: 'snippet',
        subjectOid: result.snippet.id,
      }).catch(() => undefined);
      return c.json({ snippet: await presentSingle(scope, result.snippet), files: result.files }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create snippet'), toServiceStatus(error));
    }
  });

  app.get('/user/snippets/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const scope = getScope(c);
      const result = await scope.get(Tokens.SnippetService).getSnippet(c.req.param('id'), email);
      if (result.snippet.ownerEmail.toLowerCase() !== email.toLowerCase()) return jsonError(c, 'Not found', 404);
      return c.json({ snippet: await presentSingle(scope, result.snippet), files: result.files });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  app.patch('/user/snippets/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, oversized, body } = await readJsonBody<{ title?: unknown; visibility?: unknown; files?: unknown }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
      const result = await scope.get(Tokens.SnippetService).updateSnippet(c.req.param('id'), email, body);
      return c.json({ snippet: await presentSingle(scope, result.snippet), files: result.files });
    } catch (error) {
      const status = toServiceStatus(error);
      if (error instanceof Error && error.message.includes('Only the snippet owner')) return jsonError(c, error.message, 403);
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update snippet'), status);
    }
  });

  app.delete('/user/snippets/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      await getScope(c).get(Tokens.SnippetService).deleteSnippet(c.req.param('id'), email);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Only the snippet owner')) return jsonError(c, error.message, 403);
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });
}

export { registerSnippetPublicRoutes, registerSnippetUserRoutes };
export type { SnippetApp };
