# Edge-Git — Runtime And Configuration

Scope: Wrangler bindings, build output, env vars. Parent index: `../../../AGENTS.md`.

- Root `@edge-git/monorepo`, pnpm workspaces (`apps/*`, `packages/*`).
- `apps/web/vite.config.ts` proxies `/user` + `/repos` → `http://localhost:8787` in dev; `closeBundle` embeds `dist/index.html` into `apps/api/src/generated/spa-shell.ts` (`SPA_HTML`) on build.
- `apps/api/wrangler.template.jsonc` is the config template — copy to `wrangler.jsonc` per deployer; no committed `wrangler.jsonc`. Local `wrangler.jsonc` uses `DEV_AUTH_EMAIL=test@example.com`.
- The Worker always serves the SPA from `/`, `/new`, `/settings`, `/:owner/:repo`, `/user/*` catch-all in `EdgeGitWorker` (non-matching paths return `404`) so Smart HTTP routes are never intercepted.
- Bindings: D1 `DB`, KV `CACHE` (single namespace, domain-prefixed keys via `KvCache` in `@edge-git/backend-runtime/kv`: `jwks`/`oauth2`/`code`/`searchCursor`/`refs`/`ratelimit`), DOs `REPO` (`RepoWorker`, `getByName(canonicalDoKey)` lowercased `owner/name` via `repoDoKeyForFullName`, device size from `DO_DEVICE_BYTES`, `/repo` bare) / `CRON_TASKS` (`CronTasksWorker`, `idFromName('global')`), cron `*/10 * * * *`; no R2/Queues/AI bindings.

## D1 migrations

- `migrations/*.sql` applies in filename order via `wrangler d1 migrations apply`; the integration harness concatenates the same files (`test/integration/vitest.config.mts` → `__INTEGRATION_MIGRATION_FILES__`) and applies **one file per `db.batch()`** because D1 scopes PRAGMAs to the current transaction. `applyMigrations(db, {from, to})` applies a range — needed to exercise a legacy database (apply up to `0027`, seed, then apply `0028`).
- **D1 enforces foreign keys in queries and migrations, and honours neither `PRAGMA foreign_keys = off` nor `PRAGMA legacy_alter_table = on` through the Worker binding** (verified empirically: a dangling FK insert is still rejected with `foreign_keys = off`, and renaming a parent still rewrites its children's FK clauses). `PRAGMA defer_foreign_keys = on` *is* honoured, but per D1's own documentation it does **not** suppress `ON DELETE CASCADE`. Consequences for schema changes:
  - Never plan a migration around `DROP TABLE` + `RENAME` of a table that other tables reference — the implicit `DELETE FROM` cascades. Use additive `ALTER TABLE … ADD COLUMN` and backfill.
  - The three `REFERENCES users(email)` clauses cannot be repointed, which is why `0028_user_identity.sql` freezes `users.email` as an anchor instead of rebuilding those tables.
  - A migration that *must* rebuild should prove enforcement is off before its first destructive statement, so the run aborts instead of deleting rows.
- `UserIdentityUpgrade.int.test.ts` is the template for "do not break an existing database": seed every cascade edge, apply the migration, then assert zero row loss across all of them plus `PRAGMA foreign_key_check` empty.

## Required vars (no defaults)

`POLICY_AUD`, `TEAM_DOMAIN` — Cloudflare Access JWT verification (`AccessAuthService`). No default; requests fail without them (except `DEMO_MODE`/`DEV_AUTH_EMAIL` bypass).

## Local-only (no default, not in `ConfigurationDefaults.ts`)

`DEV_AUTH_EMAIL` — bypasses Cloudflare Access locally. `DEMO_MODE` — returns `DEMO_USER_EMAIL` without verification.

## Optional vars (defaults in `ConfigurationDefaults.ts`)

| Group     | Vars (default)                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App       | `DEBUG_MODE` (`false`), `SITE_URL` (`""`)                                                                                                                                                                           |
| Limits    | `MAX_REPOS_PER_USER` (`100`), `MAX_TOKENS_PER_USER` (`5`), `MAX_TOKEN_EXPIRY_DAYS` (`90`), `DO_DEVICE_BYTES` (`5368709120`)                                                                                         |
| Git       | `MAX_PACK_OBJECTS` (`10000`), `GIT_CACHE_TTL_SECONDS` (`3600`), `MAX_FETCH_WANTS` (`64`), `MAX_FETCH_HAVES` (`512`), `MAX_PUSH_COMMANDS` (`100`), `MAX_PACK_BYTES` (`52428800`), `MAX_FETCH_BODY_BYTES` (`1048576`) |
| Retention | `BACKGROUND_TASK_RUN_RETENTION_DAYS` (`30`), `AUDIT_LOG_RETENTION_DAYS` (`90`)                                                                                                                                      |

Add new env vars in `ConfigurationDefaults.ts` (+ `ConfigurationManager` getter + `AppConfiguration` method), not inline.

## Dependency injection (`packages/backend-runtime/src/di/` + `config/`)

- `AppConfiguration` — injectable instance view over env parsing (thin facade over `RepoLimits`/`GitLimits`/`WebhookLimits`/`RealtimeLimits`/`ContentLimits`/`RetentionLimits`/`AuthConfig` sections, one method per setting, incl. `getMaxFileBytes`); `ConfigurationManager` statics remain as thin facade. Prefer injecting `AppConfiguration` in new services; mock via constructor deps. New settings go in the owning section (+ `ConfigurationDefaults` default + `ConfigurationManager` getter), not inline.
- `Container` — minimal Factory + Singleton DI (`bind`/`bindValue`/`get`/`resolve`/`createChild`). `createRequestScope(env)` in `backend-services/composition` is the standard composition root (table-driven lazy DAO wiring + single `PermissionService` binding; `scope.get(Tokens.X)`); the old `*Factory` shims were removed. `scopeMiddleware` installs a single scope per request (`getScope(c)`; `getRequestScope` fallback creates a fresh scope for helpers/tests).
- `createServiceContext(env, overrides?)` — single request-scoped `{ env, logger, clock }`; prefer extending `ServiceContext` over new `*Env` interfaces; never reintroduce `as` env casts.
- Helpers: `memoizeAsync` (composition-root memoization; rejections are never cached so transient Secrets Store/D1 failures retry), `NullLogger`/`FixedClock` (test doubles), `setRequestScope/getRequestScope/getServiceContext` (request plumbing), `asScopedContext` (single audited Hono→`ScopedContext` adapter — call sites must use it instead of `c as never`).
