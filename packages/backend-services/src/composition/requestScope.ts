import { Container, memoizeAsync } from '@edge-git/backend-runtime/di';
import { createKvCache } from '@edge-git/backend-runtime/kv';
import type { KvNamespaceLike } from '@edge-git/backend-runtime/kv';
import { setLogLevel } from '@edge-git/backend-runtime/logger';
import { SubrequestCounter } from '@rexezuge/shared';
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
  // The log level, installed for the isolate.
  //
  // Every logger in this repo is built at module scope, so the only level it
  // can read is the one installed here — the injected `env` is not reachable
  // from a logger that was built before the request existed, and workerd has
  // no `process.env`. Without this, `LOG_LEVEL=debug` shipped, was validated
  // by nothing, and was inert.
  setLogLevel((env as { LOG_LEVEL?: string }).LOG_LEVEL);
  // One counter per invocation. D1 statements, KV operations and outbound
  // fetches all spend from the same platform ceiling, and the ceiling kills
  // the invocation rather than throwing something a `catch` can see — so the
  // counter has to exist before the work does, not after.
  //
  // No ceiling is imposed: the counter *measures* what the invocation spends
  // so the number is knowable, and a deployment that wants a bound lowers it
  // with `setCeiling` rather than having one guessed here. An unmetered
  // default would make every number that budgets work quietly wrong.
  const meter = new SubrequestCounter();
  scope.bindValue(Tokens.SubrequestMeter, meter);
  // Single CACHE binding (absent in tests / legacy deploys → fail-soft cache).
  scope.bindValue(Tokens.KvCache, createKvCache((env as { CACHE?: KvNamespaceLike }).CACHE ?? null, meter));

  // Per-feature encryption keys: Secrets Store binding first (production),
  // else a raw `*_ENCRYPTION_KEY` var (integration pool + local dev without a
  // Secrets Store — test-only, never set these vars in production), else
  // throw fail-closed. A declared-but-unreadable binding still throws: the
  // vars fallback never masks a broken production binding.
  const resolveKey = (
    binding: { get(): Promise<string> } | undefined,
    rawVar: string | undefined,
    bindingName: string,
    varName: string,
  ): (() => Promise<string>) =>
    memoizeAsync(async () => {
      if (binding) return binding.get();
      if (rawVar) return rawVar;
      throw new Error(`${bindingName} is not configured for this scope (set ${varName} for tests).`);
    });
  const webhookKey = resolveKey(env.WEBHOOK_ENCRYPTION_KEY_SECRET, env.WEBHOOK_ENCRYPTION_KEY, 'WEBHOOK_ENCRYPTION_KEY_SECRET', 'WEBHOOK_ENCRYPTION_KEY');
  const mirrorKey = resolveKey(env.MIRROR_ENCRYPTION_KEY_SECRET, env.MIRROR_ENCRYPTION_KEY, 'MIRROR_ENCRYPTION_KEY_SECRET', 'MIRROR_ENCRYPTION_KEY');
  const importKey = resolveKey(env.IMPORT_ENCRYPTION_KEY_SECRET, env.IMPORT_ENCRYPTION_KEY, 'IMPORT_ENCRYPTION_KEY_SECRET', 'IMPORT_ENCRYPTION_KEY');
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
