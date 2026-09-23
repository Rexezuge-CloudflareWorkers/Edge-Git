import type { Hono } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import { WEBHOOK_EVENTS } from '@edge-git/backend-services/webhook';
import { RepoFullName } from '@edge-git/shared/utils';
import { tokenIdSchema } from '@edge-git/shared/validation';
import { jsonError, toSafeErrorMessage, toServiceStatus, getScope } from './PublicViewerResolver';
import { readJsonBody } from './BodyParser';
import { presentMany, presentSingle } from './IdentityPresenter';

type WebhookApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function repoParams(c: { req: { param(name: string): string } }): { owner: string; repoName: string } {
  return { owner: c.req.param('owner'), repoName: RepoFullName.normalizeRepo(c.req.param('repo')) };
}

// Edge UUID gate (fail fast before D1): hook/delivery ids are UUIDs minted
// by WebhookService. Rejects path-injection probes with 400 instead of a
// scoped D1 lookup.
const INVALID_HOOK_ID = 'Not found';
const INVALID_DELIVERY_ID = 'Not found';

function invalidHookId(id: string): boolean {
  return !tokenIdSchema.safeParse(id).success;
}

// Repo webhooks — list/get/deliveries need `read+`, all mutations need
// `admin`. Hook secrets are masked everywhere except the one-time `secret`
// field on create/rotate. Signing uses each hook's own unique secret
// (`X-EdgeGit-Signature-256: sha256=<hmac(secret, body)>`); receivers dedupe
// on `X-EdgeGit-Delivery`. URL validation blocks literal private/loopback
// hosts; DNS-resolved private IPs are not covered — do not point hooks at
// untrusted DNS.
function registerWebhookRoutes(app: WebhookApp): void {
  app.get('/user/repos/:owner/:repo/hooks', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { owner, repoName } = repoParams(c);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'read');
      const hooks = await scope.get(Tokens.WebhookService).listHooks(repo.id);
      return c.json({ hooks: await presentMany(scope, hooks), events: [...WEBHOOK_EVENTS] });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to list webhooks'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/hooks', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { owner, repoName } = repoParams(c);
    const { malformed, oversized, body } = await readJsonBody<{ url?: unknown; events?: unknown; secret?: unknown }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    if (typeof body.url !== 'string' || !body.url.trim()) return jsonError(c, 'url is required', 400);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const { hook, secret } = await scope.get(Tokens.WebhookService).createHook({
        repositoryId: repo.id,
        fullName: `${repo.owner}/${repo.name}`,
        url: body.url,
        events: body.events,
        secret: body.secret,
        creatorEmail: email,
      });
      return c.json({ hook: await presentSingle(scope, hook), secret }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create webhook'), toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/hooks/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { owner, repoName } = repoParams(c);
    const id = c.req.param('id');
    if (invalidHookId(id)) return jsonError(c, INVALID_HOOK_ID, 404);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'read');
      const hook = await scope.get(Tokens.WebhookService).getHook(id, repo.id);
      return c.json({ hook: await presentSingle(scope, hook) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to load webhook'), toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/hooks/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { owner, repoName } = repoParams(c);
    const id = c.req.param('id');
    if (invalidHookId(id)) return jsonError(c, INVALID_HOOK_ID, 404);
    const { malformed, oversized, body } = await readJsonBody<{ url?: unknown; events?: unknown; isActive?: unknown }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const hook = await scope.get(Tokens.WebhookService).updateHook(id, repo.id, {
        url: typeof body.url === 'string' ? body.url : undefined,
        events: body.events,
        isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
      });
      return c.json({ hook: await presentSingle(scope, hook) });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update webhook'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/hooks/:id', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { owner, repoName } = repoParams(c);
    const id = c.req.param('id');
    if (invalidHookId(id)) return jsonError(c, INVALID_HOOK_ID, 404);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      await scope.get(Tokens.WebhookService).deleteHook(id, repo.id);
      return c.json({ ok: true });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to delete webhook'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/hooks/:id/rotate-secret', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { owner, repoName } = repoParams(c);
    const id = c.req.param('id');
    if (invalidHookId(id)) return jsonError(c, INVALID_HOOK_ID, 404);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const { hook, secret } = await scope.get(Tokens.WebhookService).rotateHookSecret(id, repo.id);
      return c.json({ hook: await presentSingle(scope, hook), secret });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to rotate webhook secret'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/hooks/:id/test', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { owner, repoName } = repoParams(c);
    const id = c.req.param('id');
    if (invalidHookId(id)) return jsonError(c, INVALID_HOOK_ID, 404);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      let actorUsername = 'ghost';
      try {
        actorUsername = await scope.get(Tokens.IdentityResolver).resolveUsername(email);
      } catch {
        actorUsername = 'ghost';
      }
      const delivery = await scope
        .get(Tokens.WebhookDeliveryService)
        .sendTestPing(id, repo.id, `${repo.owner}/${repo.name}`, actorUsername);
      return c.json({ delivery }, 201);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to send test ping'), toServiceStatus(error));
    }
  });

  app.get('/user/repos/:owner/:repo/hooks/:id/deliveries', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { owner, repoName } = repoParams(c);
    const id = c.req.param('id');
    if (invalidHookId(id)) return jsonError(c, INVALID_HOOK_ID, 404);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'read');
      const url = new URL(c.req.url);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50);
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const { deliveries, nextCursor } = await scope.get(Tokens.WebhookDeliveryService).listDeliveries(id, repo.id, limit, cursor);
      return c.json({ deliveries, nextCursor });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to list deliveries'), toServiceStatus(error));
    }
  });

  app.post('/user/repos/:owner/:repo/hooks/:id/deliveries/:deliveryId/redeliver', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const { owner, repoName } = repoParams(c);
    const deliveryId = c.req.param('deliveryId');
    if (invalidHookId(deliveryId)) return jsonError(c, INVALID_DELIVERY_ID, 404);
    try {
      const scope = getScope(c);
      const { repo } = await scope.get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      const delivery = await scope.get(Tokens.WebhookDeliveryService).redeliver(deliveryId, repo.id);
      return c.json({ delivery });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to redeliver'), toServiceStatus(error));
    }
  });
}

export { registerWebhookRoutes };
