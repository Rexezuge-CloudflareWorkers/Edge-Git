import { Container, memoizeAsync } from '@edge-git/backend-runtime/di';
import { KvCache } from '@edge-git/backend-runtime/kv';
import type { KvNamespaceLike } from '@edge-git/backend-runtime/kv';
import { Tokens } from './tokens';
import type { RequestKeys, RequestScopeEnv } from './serviceFactory';
import { bindDaoBindings } from './daoBindings';
import { bindServiceBindings } from './serviceBindings';

// Composition root: builds a per-request child scope wiring DAOs → services.
// Replaces the former scattered `new X(env)` / `new XDAO(env.DB)`
// call sites in apps/api and apps/background. DAO tables live in
// `daoBindings.ts`, service wiring in `serviceBindings.ts` (god-file guard);
// this module only owns scope lifecycle + memoized secrets.
function createRequestScope(env: RequestScopeEnv): Container {
  const scope = new Container();
  scope.bindValue(Tokens.Env, env);
  scope.bindValue(Tokens.Db, env.DB);
  // Single CACHE binding (absent in tests / legacy deploys → fail-soft cache).
  scope.bindValue(Tokens.KvCache, new KvCache((env as { CACHE?: KvNamespaceLike }).CACHE ?? null));

  const masterKey = memoizeAsync(() => {
    if (!env.AES_ENCRYPTION_KEY_SECRET) throw new Error('AES_ENCRYPTION_KEY_SECRET is not configured for this scope.');
    return env.AES_ENCRYPTION_KEY_SECRET.get();
  });
  const keys = memoizeAsync(async (): Promise<RequestKeys> => ({ masterKey: await masterKey() }));
  scope.bindValue(Tokens.Keys, keys);

  bindDaoBindings(scope, env);
  bindServiceBindings(scope, env);

  return scope;
}

export { createRequestScope };
export type { RequestKeys, RequestScopeEnv } from './serviceFactory';
