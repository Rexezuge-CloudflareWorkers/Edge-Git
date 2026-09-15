# Edge-Git — Testing

Scope: unit + integration tests. Parent index: `../../../AGENTS.md`.

Current thresholds (`vitest.config.mts`): **statements 55 / branches 50 / functions 60 / lines 55** (raised stepwise from 50/40/50/50 after DI + god-file splits + composition/i18n tests; measured ~58/51/62/58). Exclusions: `**/*.test.ts`, `**/*.d.ts`, `**/index.ts`, `**/types.d.ts`, `**/model/**`. Integration in `test/integration/` uses `@cloudflare/vitest-pool-workers` (no V8 coverage — no thresholds there, omitted intentionally). God-file guard: `scripts/check-god-files.mjs` (soft 300 / hard 400 LOC; warn-only).
Raise plan (stepwise, only when green with headroom): 55/50/60/55 → 70/55/70/70 → 85/70/85/85 → Otter parity 88.5/76.5/90.5/89.5. Never lower thresholds to make CI pass. (Measured 2026-09-15: 57.9/51.2/62.5/58.1 — above floors, below the 70/55/70/70 rung, so thresholds stay.)

**Covered** (test files exist): error classes + `Container`/`ServiceContext`/`AppConfiguration`/`ConfigurationManager`, `CryptoUtil`/`UUIDUtil`/`TimestampUtil`, pkt-line + v2 fetch/receive builders/parsers + limits, `GitService` pack/ref paths, DAOs (`Repository/User/UserAccessToken/Issue`), services (`Repo/User/Token/Issue`), `AccessAuthService` (DEMO/DEV/JWT fallbacks), request-scope composition (`Tokens` registry + `createRequestScope` memoization + ctor-injected DAO overrides, Otter `createMockDb`/`vi.mock`/`vi.hoisted` pattern), shared i18n (`getBackendStrings` en/zh-CN + fallback + `formatBackendString`; web bundles via `validate_locales` invocation), worker routes + middleware auth, cron `TaskRegistry` phases.

**Still thin**: `RepoWorker` DO lifecycle (needs DO harness), `IsoGitFs`/`dofs` edge cases, SPA components (no web unit tests yet).

**Mock patterns**:

- DAOs/services: in-memory fake D1 (`createFakeDb`/`createDaoFakeDb` in `test/services.test.ts`/`test/dao.test.ts`) implementing `prepare().bind().first/all/run` with per-table arrays; assert via state, not `vi.mock`.
- PAT hashing: real `TokenService.hashToken` (`sha256 edge-git-pat:`) with ephemeral random tokens; expiry via `TimestampUtil` arithmetic.
- Access auth: stub env (`DEV_AUTH_EMAIL`/`DEMO_MODE`) or `cf-access-jwt-assertion` header with mocked `jose`; never trust `Cf-Access-Authenticated-User-Email`.
- Integration: `test/integration/vitest.config.mts` + `wrangler.test.jsonc` pool, shared `__INTEGRATION_MIGRATION_SQL__` seeding; `beforeEach` + fresh fakes, no cross-test state. `helpers/setup.ts` (`setupIntegrationTest`/`ensureUser`/`seedRepo`) + `helpers/migrations.ts` (`splitSql`) back `api/RepoCrud|TokenLifecycle|IssueLifecycle.int.test.ts` (real D1 via `SELF.fetch`, `DEV_AUTH_EMAIL`). BLOCKER: pool workerd predates standard decorators and rejects `dofs/dist/index.js` (`@Dofs(...)`, uncompiled upstream) with a bare `SyntaxError` on any `SELF` test — flows re-validated against `wrangler dev` + real D1/DO instead; unblocks when `dofs` ships compiled dist or the pool updates workerd.
