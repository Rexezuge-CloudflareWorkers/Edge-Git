import type { Context, Next } from 'hono';
import { setRequestScope as kitSetRequestScope } from '@rexezuge/runtime';
import { createServiceContext, setServiceContext, asScopedContext } from '@edge-git/backend-runtime/di';
import { createRequestScope } from '@edge-git/backend-services/composition';

type ScopeContext = Context<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

/**
 * Single-scope-per-request middleware (Otter composition-root pattern).
 * Creates one `Container` + one `ServiceContext` per request and stores them
 * on the Hono context. Handlers resolve via `getRequestScope(c)` instead of
 * calling `createRequestScope(c.env)` per handler (which minted N scopes per
 * request and defeated singleton memoization).
 */
async function scopeMiddleware(c: ScopeContext, next: Next): Promise<Response | void> {
  const scoped = asScopedContext(c);
  kitSetRequestScope(scoped, createRequestScope(c.env));
  setServiceContext(scoped, createServiceContext(c.env));
  await next();
}

export { scopeMiddleware };
