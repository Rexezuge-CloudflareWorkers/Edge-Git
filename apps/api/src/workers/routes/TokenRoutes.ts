import type { Hono } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';

type TokenApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function registerTokenRoutes(app: TokenApp): void {
  app.get('/user/tokens', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const svc = createRequestScope(c.env).get(Tokens.TokenService);
    const tokens = await svc.listTokens(email);
    return c.json({
      tokens: tokens.map((t) => ({
        tokenId: t.tokenId,
        name: t.name,
        expiresAt: t.expiresAt,
        lastUsedAt: t.lastUsedAt,
        createdAt: t.createdAt,
        scopes: t.scopes,
      })),
    });
  });

  app.post('/user/tokens', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; expiresInDays?: number; scopes?: unknown };
    if (!body.name) return c.json({ error: 'name is required' }, 400);
    try {
      const svc = createRequestScope(c.env).get(Tokens.TokenService);
      const created = await svc.createToken(email, body.name, body.expiresInDays, body.scopes);
      return c.json(created, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Failed' }, 400);
    }
  });

  app.delete('/user/tokens/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const svc = createRequestScope(c.env).get(Tokens.TokenService);
    await svc.deleteToken(c.req.param('id'), email);
    return c.json({ ok: true });
  });
}

export { registerTokenRoutes };
