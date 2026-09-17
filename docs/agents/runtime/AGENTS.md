# Edge-Git — Runtime And Configuration

Scope: Wrangler bindings, build output, env vars. Parent index: `../../../AGENTS.md`.

- Root `@edge-git/monorepo`, pnpm workspaces (`apps/*`, `packages/*`).
- `apps/web/vite.config.ts` proxies `/user` + `/repos` → `http://localhost:8787` in dev; `closeBundle` embeds `dist/index.html` into `apps/api/src/generated/spa-shell.ts` (`SPA_HTML`) on build.
- `apps/api/wrangler.template.jsonc` is the config template — copy to `wrangler.jsonc` per deployer; no committed `wrangler.jsonc`. Local `wrangler.jsonc` uses `DEV_AUTH_EMAIL=test@example.com`, `SERVE_SPA_FROM_WORKER=false`.
- Worker serves SPA only from `/`, `/new`, `/settings`, `/:owner/:repo`, `/user/*` catch-all in `EdgeGitWorker` (non-matching paths return `404`) so Smart HTTP routes are never intercepted.
- Bindings: D1 `DB`, DOs `REPO` (`RepoWorker`, `getByName(fullName)`, 5GB, `/repo` bare) / `CRON_TASKS` (`CronTasksWorker`, `idFromName('global')`), cron `*/10 * * * *`; no KV/R2/Queues/AI bindings.

## Required vars (no defaults)

`POLICY_AUD`, `TEAM_DOMAIN` — Cloudflare Access JWT verification (`AccessAuthService`). No default; requests fail without them (except `DEMO_MODE`/`DEV_AUTH_EMAIL` bypass).

## Local-only (no default, not in `ConfigurationDefaults.ts`)

`DEV_AUTH_EMAIL` — bypasses Cloudflare Access locally. `DEMO_MODE` — returns `DEMO_USER_EMAIL` without verification.

## Optional vars (defaults in `ConfigurationDefaults.ts`)

| Group | Vars (default) |
|---|---|
| App | `DEBUG_MODE` (`false`), `SITE_URL` (`""`), `SERVE_SPA_FROM_WORKER` (`true`) |
| Limits | `MAX_REPOS_PER_USER` (`100`), `MAX_TOKENS_PER_USER` (`5`), `MAX_TOKEN_EXPIRY_DAYS` (`90`) |
| Git | `MAX_PACK_OBJECTS` (`10000`), `GIT_CACHE_TTL_SECONDS` (`3600`), `MAX_FETCH_WANTS` (`64`), `MAX_FETCH_HAVES` (`512`), `MAX_PUSH_COMMANDS` (`100`), `MAX_PACK_BYTES` (`52428800`), `MAX_FETCH_BODY_BYTES` (`1048576`) |
| Retention | `BACKGROUND_TASK_RUN_RETENTION_DAYS` (`30`), `AUDIT_LOG_RETENTION_DAYS` (`90`) |

Add new env vars in `ConfigurationDefaults.ts` (+ `ConfigurationManager` getter + `AppConfiguration` method), not inline.

## Dependency injection (`packages/backend-runtime/src/di/` + `config/`)

- `AppConfiguration` — injectable instance view over env parsing (one method per setting); `ConfigurationManager` statics remain as thin facade. Prefer injecting `AppConfiguration` in new services; mock via constructor deps.
- `Container` — minimal Factory + Singleton DI (`bind`/`bindValue`/`get`/`resolve`/`createChild`). `createRequestScope(env)` in `backend-services/composition` is the standard composition root (`scope.get(Tokens.X)`); the old `*Factory` shims were removed.
- `createServiceContext(env, overrides?)` — single request-scoped `{ env, logger, clock }`; prefer extending `ServiceContext` over new `*Env` interfaces; never reintroduce `as` env casts.
