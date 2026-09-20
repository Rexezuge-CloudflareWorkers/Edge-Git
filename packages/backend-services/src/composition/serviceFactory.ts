import type { D1Queryable } from '@edge-git/backend-data/utils';

// Minimal structural env for scope creation. Secrets are resolved lazily and
// memoized — requests that never touch encrypted state pay no Secrets Store
// round-trip.
//
// NOTE: no `[key: string]: unknown` index signature on purpose — interfaces
// (e.g. endpoint `*Env`) do not carry an implicit index signature, so a target
// with one would reject every `createRequestScope(env)` call site. Extra
// bindings are still assignable structurally; services receive `env as never`.
interface RequestScopeEnv {
  DB: D1Queryable;
  AES_ENCRYPTION_KEY_SECRET?: { get(): Promise<string> };
}

interface RequestKeys {
  masterKey: string;
}

// Single audited unsafe-cast location for service envs. Services declare
// narrow `*Env` interfaces (e.g. `{ DB, MAX_* }`); the composition root holds
// the minimal `RequestScopeEnv`. Centralizing `as never` here keeps ~30 call
// sites readable and makes future `ServiceEnv` migration a one-line change.
function asServiceEnv(env: RequestScopeEnv): never {
  return env as never;
}

// Generic service factory (AWS `createService` pattern). Kills `new X(env)`
// boilerplate repetition and keeps ctor-injection visible in one place.
function createService<T, D>(Ctor: new (env: never, deps?: D) => T, env: RequestScopeEnv, deps?: D): T {
  return new Ctor(asServiceEnv(env), deps);
}

export { asServiceEnv, createService };
export type { RequestKeys, RequestScopeEnv };
