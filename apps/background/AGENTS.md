# Edge-Git — Background Worker

Scope: `apps/background/**`. Parent index: `../../AGENTS.md`.

- `src/index.ts` — re-exports `RepoWorker`, `CronTasksWorker` (also re-exported by `apps/api/src/index.ts` for DO bindings).
- `RepoWorker` (`src/RepoWorker.ts`) — one Durable Object per repo (`REPO.getByName(fullName)`); bare repo at `/repo` over `DofsFs` (5 GB via `setDeviceSize`) + `IsoGitFs` + `GitService`. Lazy init via `ensureRepoInitialized()`; never nest `blockConcurrencyWhile` (deadlocks DO init). Entry: fetch/push pack handlers + read-model RPC (`listRefs`, `getBranches/Tree/Blob/Commits`, `setFullName`, `deleteRepo`).
- `FetchHandler` / `PushHandler` — pack fetch/push protocol handling inside the DO; `ReadModelService` — branches/tree/blob/commits reads served to the API passthroughs; `ReleaseAssetStore` — release asset bytes under `/release-assets/<releaseId>/<assetId>` (outside `/repo`, inside the 5GB device; D1 holds metadata only).
- `CronTasksWorker` (`src/CronTasksWorker.ts`) — `POST /run` only (else `404`); single-flight (`202 Already running`); awaits `runScheduledTasks`. Triggered by cron `*/10 * * * *` (see API wrangler template) + `CronTasksWorker` binding.
- `src/scheduled/TaskRegistry.ts` — `CRON_TASK_DEFINITIONS: ScheduledTask[]` with `phase: 1 | 2`; `runScheduledTasks` runs phase 1 fully, then phase 2 (each phase `Promise.all`, per-task catch-and-log). Phase 1: `ExpiredTokenPruningTask` (`pruneExpired(now, 500)`, logs count). Phase 2: `BackgroundTaskRunPruningTask` (retention config, no-op v1), `SearchBackfillTask` (code-index catch-up), `SocialPruningTask` (prune `repo_events`/read `notifications` by `AUDIT_LOG_RETENTION_DAYS` + `webhook_deliveries` by `WEBHOOK_DELIVERY_RETENTION_DAYS`), `AuditLogCleanupTask` (prune `audit_logs` by `AUDIT_LOG_RETENTION_DAYS`, batch 500), `WebhookDeliveryTask` (cron sweeper for due webhook deliveries, limit 50).
- Composition: resolve per-request state via `createRequestScope(env).get(Tokens.X)`; never `new XDAO(env.DB)` inline.
- Tests: cron phases via unit worker tests with fake D1; DO lifecycle needs a DO harness (still thin — see `docs/agents/testing/AGENTS.md`).
