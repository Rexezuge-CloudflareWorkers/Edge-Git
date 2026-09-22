import type { Hono } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import { tokenIdSchema } from '@edge-git/shared/validation';
import { jsonError, toSafeErrorMessage, toServiceStatus, getScope } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';

type TokenApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function registerTokenRoutes(app: TokenApp): void {
  app.get('/user/tokens', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const svc = getScope(c).get(Tokens.TokenService);
    const tokens = await svc.listTokens(email);
    return c.json({
      tokens: tokens.map((t) => ({
        tokenId: t.tokenId,
        name: t.name,
        expiresAt: t.expiresAt,
        lastUsedAt: t.lastUsedAt,
        createdAt: t.createdAt,
        scopes: t.scopes,
        tokenPrefix: t.tokenPrefix,
        repoGrants: t.repoGrants ?? [],
      })),
    });
  });

  app.post('/user/tokens', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { malformed, body } = await readJsonBody<{
      name?: string;
      expiresInDays?: number;
      scopes?: unknown;
      repoGrants?: unknown;
    }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (!body.name) return jsonError(c, 'name is required', 400);
    try {
      const svc = getScope(c).get(Tokens.TokenService);
      const created = await svc.createToken(email, body.name, body.expiresInDays, body.scopes, body.repoGrants);
      return c.json(created, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });

  // Rotation mints a fresh secret for the same token identity (name,
  // scopes, and repo grants are preserved; the lifetime window restarts
  // from the original duration). The old secret stops working immediately.
  app.post('/user/tokens/:id/rotate', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    if (!tokenIdSchema.safeParse(c.req.param('id')).success) return jsonError(c, 'Invalid token id', 400);
    try {
      const svc = getScope(c).get(Tokens.TokenService);
      const rotated = await svc.rotateToken(c.req.param('id'), email);
      return c.json(rotated, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });

  app.delete('/user/tokens/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    if (!tokenIdSchema.safeParse(c.req.param('id')).success) return jsonError(c, 'Invalid token id', 400);
    try {
      const svc = getScope(c).get(Tokens.TokenService);
      await svc.deleteToken(c.req.param('id'), email);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed'), toServiceStatus(error));
    }
  });
}

export { registerTokenRoutes };
