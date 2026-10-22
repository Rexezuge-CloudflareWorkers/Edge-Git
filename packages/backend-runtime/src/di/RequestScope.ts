import {
  asScopedContext as kitAsScopedContext,
  getRequestScope as kitGetRequestScope,
  tryGetRequestScope as kitTryGetRequestScope,
} from '@rexezuge/runtime';
import type { ScopedContext } from '@rexezuge/runtime';
import type { ServiceEnv } from '../config/ServiceEnv';
import { createServiceContext } from './ServiceContext';
import type { ServiceContext, ServiceContextOverrides } from './ServiceContext';

/**
 * Per-request wiring on top of the kit's scope.
 *
 * The container, the scope key and the `get`/`set` plumbing are the kit's — one
 * `Container` per request, stored on the framework context under `SCOPE_KEY`.
 * What stays here is the half Edge-Git added on top: the `ServiceContext` that
 * carries the clock, the logger and the test seams, plus the memoized async
 * factory the composition root needs.
 */

/**
 * Memoized async factory helper for the composition root.
 * Replaces hand-rolled `let pending; return () => (pending ??= fn())`
 * closures scattered across `requestScope.ts`.
 *
 * Rejections are never cached: a transient Secrets Store / D1 failure must
 * not poison the whole request scope — the next call retries.
 */
function memoizeAsync<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      pending = fn();
      pending.catch(() => {
        pending = undefined;
      });
    }
    return pending;
  };
}

/**
 * Single-scope-per-request helper (Otter pattern).
 * Middleware creates one `Container` + one `ServiceContext` per request and
 * stores them on the Hono context; handlers resolve via `getScope(c)` instead
 * of calling `createRequestScope(c.env)` per handler (which minted N scopes
 * per request and broke singleton memoization).
 */
const SERVICE_CONTEXT_KEY = '__edgeGitServiceContext';

function setServiceContext(c: ScopedContext, ctx: ServiceContext): void {
  c.set(SERVICE_CONTEXT_KEY, ctx);
}

function getServiceContext(c: ScopedContext): ServiceContext {
  const ctx = c.get(SERVICE_CONTEXT_KEY) as ServiceContext | undefined;
  if (!ctx) throw new Error('Service context is not set. Register scopeMiddleware before routes.');
  return ctx;
}

function createRequestContext(env: ServiceEnv, overrides: ServiceContextOverrides = {}): ServiceContext {
  return createServiceContext(env, overrides);
}

/**
 * Structural adapter for Hono contexts, from the kit. Re-exported so this
 * module stays the one import site for the scope plumbing.
 */
const asScopedContext = kitAsScopedContext;
const getRequestScope = kitGetRequestScope;
/**
 * The installed scope, or `null`.
 *
 * The way to ask without throwing: `getRequestScope` is right where a missing
 * scope is a bug that should surface, this is right where it is an expected
 * branch — and it is checked by construction, so it cannot drift from the
 * message the throwing form uses.
 */
const tryGetRequestScope = kitTryGetRequestScope;

export {
  asScopedContext,
  createRequestContext,
  getRequestScope,
  getServiceContext,
  memoizeAsync,
  setServiceContext,
  tryGetRequestScope,
};

export { SERVICE_CONTEXT_KEY };
export {type Container, type ScopedContext} from '@rexezuge/runtime';