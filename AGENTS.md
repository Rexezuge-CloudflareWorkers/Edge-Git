# AGENTS.md

Edge-Git: Cloudflare Workers git server (`@edge-git/monorepo`, `pnpm@11.2.2`).

- **Git core**: `packages/git-protocol` (pkt-line, v2 upload/v0 receive builders/parsers), `packages/git-service` (`GitService` + `IsoGitFs` over `dofs` + `isomorphic-git`).
- **Storage**: `apps/background` `RepoWorker` DO (one per repo, `getByName(fullName)`, 5GB, `/repo` bare) + `CronTasksWorker` (`*/10 * * * *`, token prune); D1 `migrations/0001_squash.sql`.
- **Auth**: `/user/*` Cloudflare Access (`AccessAuthService`: DEMO→DEV→JWT→`ctx.access` fallback; never trust `Cf-Access-Authenticated-User-Email`); git anon (public fetch) + PAT Basic/Bearer (`TokenService`, sha256 `edge-git-pat:` prefix, `MAX_TOKENS_PER_USER=5`).
- **API**: `apps/api` Hono+Chanfana `EdgeGitWorker` (`/:owner/:repo/info/refs|git-upload-pack|git-receive-pack` + `/user/me|repos|tokens|issues` + `/health`, `/docs`); `apps/api/src/index.ts` re-exports DOs for bindings.
- **Web**: `apps/web` Vite SPA, build embeds `dist/index.html` → `apps/api/src/generated/spa-shell.ts`.

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
