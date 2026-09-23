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

  const webhookKey = memoizeAsync(async () => {
    if (!env.WEBHOOK_ENCRYPTION_KEY_SECRET) throw new Error('WEBHOOK_ENCRYPTION_KEY_SECRET is not configured for this scope.');
    return env.WEBHOOK_ENCRYPTION_KEY_SECRET.get();
  });
  const mirrorKey = memoizeAsync(async () => {
    if (!env.MIRROR_ENCRYPTION_KEY_SECRET) throw new Error('MIRROR_ENCRYPTION_KEY_SECRET is not configured for this scope.');
    return env.MIRROR_ENCRYPTION_KEY_SECRET.get();
  });
  const importKey = memoizeAsync(async () => {
    if (!env.IMPORT_ENCRYPTION_KEY_SECRET) throw new Error('IMPORT_ENCRYPTION_KEY_SECRET is not configured for this scope.');
    return env.IMPORT_ENCRYPTION_KEY_SECRET.get();
  });
  // Per-feature thunks: resolving one key never fetches the other two.
  scope.bindValue(Tokens.WebhookKey, webhookKey);
  scope.bindValue(Tokens.MirrorKey, mirrorKey);
  scope.bindValue(Tokens.ImportKey, importKey);
  const keys = memoizeAsync(async (): Promise<RequestKeys> => ({
    webhookKey: await webhookKey(),
    mirrorKey: await mirrorKey(),
    importKey: await importKey(),
  }));
  scope.bindValue(Tokens.Keys, keys);

  bindDaoBindings(scope, env);
  bindServiceBindings(scope, env);

  return scope;
}

export { createRequestScope };
export type { RequestKeys, RequestScopeEnv } from './serviceFactory';
