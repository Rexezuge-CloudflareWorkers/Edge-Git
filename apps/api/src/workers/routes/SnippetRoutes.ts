import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { emitWebhookEvent } from './SocialEmit';
import { toSafeErrorMessage, toServiceStatus } from './PublicViewerResolver';

type SnippetApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function registerSnippetPublicRoutes(app: SnippetApp): void {
  app.get('/snippets/public', async (c) => {
    try {
      const url = new URL(c.req.url);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20) || 20, 1), 50);
      const snippets = await createRequestScope(c.env).get(Tokens.SnippetService).listPublic(limit);
      return c.json({ snippets });
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
        viewerEmail = await createRequestScope(c.env)
          .get(Tokens.AccessAuthService)
          .getAuthenticatedUserEmail(c.req.raw, c.executionCtx as never);
      } catch {
        viewerEmail = null;
      }
      const result = await createRequestScope(c.env).get(Tokens.SnippetService).getSnippet(c.req.param('id'), viewerEmail);
      return c.json(result);
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
    }
  });

  app.get('/users/:username/snippets', async (c) => {
    try {
      const username = c.req.param('username');
      const user = await createRequestScope(c.env).get(Tokens.UserService).getByUsername(username);
      if (!user) return c.json({ error: 'Not found' }, 404);
      let viewerEmail: string | null = null;
      try {
        viewerEmail = await createRequestScope(c.env)
          .get(Tokens.AccessAuthService)
          .getAuthenticatedUserEmail(c.req.raw, c.executionCtx as never);
      } catch {
        viewerEmail = null;
      }
      const snippets = await createRequestScope(c.env).get(Tokens.SnippetService).listByOwner(user.email, viewerEmail);
      return c.json({ snippets });
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
    }
  });
}

function registerSnippetUserRoutes(app: SnippetApp): void {
  app.get('/user/snippets', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const snippets = await createRequestScope(c.env).get(Tokens.SnippetService).listByOwner(email, email);
      return c.json({ snippets });
    } catch {
      return c.json({ snippets: [] });
    }
  });

  app.post('/user/snippets', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown; visibility?: unknown; files?: unknown };
    try {
      const scope = createRequestScope(c.env);
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
      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed to create snippet') }, toServiceStatus(error));
    }
  });

  app.get('/user/snippets/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      const result = await createRequestScope(c.env).get(Tokens.SnippetService).getSnippet(c.req.param('id'), email);
      if (result.snippet.ownerEmail.toLowerCase() !== email.toLowerCase()) return c.json({ error: 'Not found' }, 404);
      return c.json(result);
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
    }
  });

  app.patch('/user/snippets/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const body = (await c.req.json().catch(() => ({}))) as { title?: unknown; visibility?: unknown; files?: unknown };
    try {
      const result = await createRequestScope(c.env).get(Tokens.SnippetService).updateSnippet(c.req.param('id'), email, body);
      return c.json(result);
    } catch (error) {
      const status = toServiceStatus(error);
      if (error instanceof Error && error.message.includes('Only the snippet owner')) return c.json({ error: error.message }, 403);
      return c.json({ error: toSafeErrorMessage(error, 'Failed to update snippet') }, status);
    }
  });

  app.delete('/user/snippets/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    try {
      await createRequestScope(c.env).get(Tokens.SnippetService).deleteSnippet(c.req.param('id'), email);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof Error && error.message.includes('Only the snippet owner')) return c.json({ error: error.message }, 403);
      return c.json({ error: toSafeErrorMessage(error, 'Not found') }, toServiceStatus(error));
    }
  });
}

export { registerSnippetPublicRoutes, registerSnippetUserRoutes };
export type { SnippetApp };
