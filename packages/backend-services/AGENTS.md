# Edge-Git — Backend Services

Scope: `packages/backend-services/**`. Parent index: `../../AGENTS.md`. Layer 3 (may use layers 0–2 only, never apps).

- Domain map:
  - `src/auth/AccessAuthService.ts` — `/user/*` identity: `DEMO_MODE` → `DEV_AUTH_EMAIL` → JWT (`cf-access-jwt-assertion` vs `TEAM_DOMAIN`/`POLICY_AUD`) → `ctx.access.getIdentity()` fallback. Never trust `Cf-Access-Authenticated-User-Email`.
  - `src/auth/TokenService.ts` — PATs: `sha256("edge-git-pat:" + token)`, `MAX_TOKENS_PER_USER` (default 5), `MAX_TOKEN_EXPIRY_DAYS`; mint/authenticate (`authenticateWithPAT` + `last_used_at` touch)/list/revoke.
  - `src/repo/RepoService.ts` — repo CRUD by `(owner, name)`: `normalizeOwner/normalizeRepo` (strip `.git`), `validateNames`, owner-only update/delete (delete cascades issues), `MAX_REPOS_PER_USER`.
  - `src/user/UserService.ts` — `upsertUser` (lowercased email, idempotent; called by auth middleware).
  - `src/issue/IssueService.ts` — per-repo auto-numbering (`MAX(number)+1`), newest-first `listByRepo`.
- `src/composition/` — `Tokens` registry (`tokens.ts`: `Env/Db/Keys/AppConfig`, DAO factories, services) + `createRequestScope(env)` (`requestScope.ts`): per-request `Container`, memoized `Keys`/DAO factories (no Secrets Store round-trip until used), lazy `AppConfig`. Handlers resolve `scope.get(Tokens.X)`; `*Factory.create({ DB })` re-exports in `composition/index.ts` are deprecated shims.
- Constructor injection: every service takes `(env, deps?)` with `() => Promise<DAO>` factories defaulting to real DAOs — tests override with fakes (see `test/composition.test.ts`), no module mocks needed.
- Errors via `@edge-git/backend-errors` (`Bad/Unauthorized/Forbidden/NotFoundError`); time/ids via `@edge-git/shared/utils` (`TimestampUtil`, `UUIDUtil`, `CryptoUtil`).
