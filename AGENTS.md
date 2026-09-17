# AGENTS.md

Edge-Git: Cloudflare Workers git server (`@edge-git/monorepo`, `pnpm@11.2.2`).

- **Git core**: `packages/git-protocol` (pkt-line, v2 upload/v0 receive builders/parsers), `packages/git-service` (`GitService` + `IsoGitFs` over `dofs` + `isomorphic-git`).
- **Storage**: `apps/background` `RepoWorker` DO (one per repo, `getByName(fullName)`, 5GB, `/repo` bare) + `CronTasksWorker` (`*/10 * * * *`, token prune); D1 `migrations/0001_squash.sql` + `migrations/0002_permissions.sql` (usernames, orgs, collaborators).
- **Auth**: `/user/*` Cloudflare Access (`AccessAuthService`: DEMO→DEV→JWT→`ctx.access` fallback; never trust `Cf-Access-Authenticated-User-Email`); email login, globally-unique mutable username (`user ↔ org` single namespace); git anon (public fetch) + PAT Basic/Bearer (`TokenService`, sha256 `edge-git-pat:` prefix, `MAX_TOKENS_PER_USER=5`, inherits repo/org permissions).
- **API**: `apps/api` Hono+Chanfana `EdgeGitWorker` (`/:owner/:repo/info/refs|git-upload-pack|git-receive-pack` + `/user/me|repos|orgs|tokens|issues` + `/users/:username` + `/health`, `/docs`); permissions `admin|write|read` (org `owner|member`, owner+member may create org repos); `apps/api/src/index.ts` re-exports DOs for bindings.
- **Web**: `apps/web` Vite SPA, build embeds `dist/index.html` → `apps/api/src/generated/spa-shell.ts`.
- **Composition**: per-request `createRequestScope(env)` from `@edge-git/backend-services/composition` (`scope.get(Tokens.X)` is the standard; the old `*Factory` shims were removed); `Container` + `createServiceContext` + `AppConfiguration` in `@edge-git/backend-runtime/di+config` are the DI foundation. See `docs/agents/runtime/AGENTS.md`.
- **i18n**: backend strings in `packages/shared/src/i18n` (`en`, `zh-CN`) + web i18next (`SUPPORTED_LANGUAGES` 12 tags, `en`+`zh-CN` bundles shipped); English UI text uses Title Case. See `apps/web/AGENTS.md`.

## Commands

```bash
pnpm install
pnpm -r typecheck && pnpm run lint && pnpm run test:coverage && pnpm run test:integration
pnpm --filter @edge-git/web build
pnpm run typegen
pnpm exec wrangler dev --config ./wrangler.jsonc
```

No committed `wrangler.jsonc`. God-file guard 300/400 warn-only.

## Layers

```
shared, backend-errors → 0 deps
backend-runtime → 0 only
backend-data, git-protocol → 0 only
git-service → 0-2
backend-services → 0-2 (not apps)
background → 0-3
api → 0-3 + background (no DAO value imports in endpoints)
```

## Import Direction

```
Layer 0: shared, backend-errors          — zero @edge-git/* deps
Layer 1: backend-runtime                 → layer 0 only
Layer 2: backend-data, git-protocol      → layer 0 only
Layer 2-3: git-service                   → layers 0–2 (not backend-services/apps)
Layer 3: backend-services                → layers 0–2 (not apps)
(no Layer 4 by design)
Layer 5: apps/background                 → layers 0–3 + git-* (not apps/api)
         apps/api                        → layers 0–3 + background (NOT git-service directly; NOT backend-data/dao except type-only)
```

Enforced by ESLint `no-restricted-imports` in `eslint.config.mjs`: `apps/api` blocks `→ @edge-git/git-service` (all imports) and `→ @edge-git/backend-data/dao` (`allowTypeImports: true`). `apps/api → apps/background` re-export is allowed (`src/index.ts` re-exports `CronTasksWorker`, `RepoWorker` for bindings).

## Index

| Area | Guide |
| ---- | ----- |
| API worker, auth, routes | `apps/api/AGENTS.md` |
| Background worker, cron phases, task visibility | `apps/background/AGENTS.md` |
| Web SPA, router, i18n/Title Case conventions | `apps/web/AGENTS.md` |
| Business logic, service domain map | `packages/backend-services/AGENTS.md` |
| D1/DAO layer | `packages/backend-data/AGENTS.md` |
| Git pkt-line/protocol roles | `packages/git-protocol/AGENTS.md` |
| Bindings, wrangler, env vars, DI | `docs/agents/runtime/AGENTS.md` |
| Tests, thresholds, mock patterns | `docs/agents/testing/AGENTS.md` |

## Commit Policy

Always commit changes after completing work unless explicitly told not to.

## Git Commit Messages

Format: `<TYPE>[optional scope]: <description>`

- Type in UPPERCASE: `FIX`, `FEAT`, `DOCS`, `STYLE`, `REFACTOR`, `TEST`, `BUILD`, `CHORE`, `CI`, `PERF`.
- Scope in lowercase: `FEAT(runtime): Add Scheduled Job State`.
- Description: Title Case words — `DOCS: Latest Agents Context Reflection`.
- When committing from `main`, first create a branch: `type/description` or `type/scope/description` in kebab-case (e.g. `feat/bootstrap/bootstrap-jqanywhere-v0.1-framework`).
- Always include a Markdown body separated from the subject by a blank line.
- Breaking changes: `!` after type/scope, or `BREAKING CHANGE: <description>` footer.

```text
<TYPE>[optional scope]: <description>

[Markdown body]

[optional footers]
```
