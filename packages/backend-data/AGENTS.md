# Edge-Git — Backend Data (D1/DAO Layer)

Scope: `packages/backend-data/**`. Parent index: `../../AGENTS.md`.

- All D1 access via DAOs over `D1Queryable`: `BaseDAO` (`withRetry` + static `findById`/`deleteOlderThan` + instance `findRowById`/`deleteRowsOlderThan`/`encodeCursor`/`decodeCursor`), `RepositoryDAO` (owner/name, owner-email listing, CRUD), `UserDAO` (`upsertUser`/`getByEmail`), `UserAccessTokenDAO` (hash lookup, expiry prune, per-user list), `IssueDAO` (+ `CommentRow`, per-repo numbering via `COALESCE(MAX(number))`).
- Utils: `D1Types` (`D1Queryable`), `D1Utils` (`executeD1WithRetry`), `D1ErrorClassifier` (retryable detection), `CursorUtil` (opaque pagination cursors). No `constants/` or `crypto/` modules — hashing lives in `@edge-git/shared/utils` (`CryptoUtil.sha256Hex`).
- Migrations in `migrations/0001_squash.sql` (`repositories`, `users`, `user_access_tokens`, `issues`); integration embeds them via `__INTEGRATION_MIGRATION_SQL__`.
- Token prune path: `UserAccessTokenDAO.pruneExpired(now, limit)` called from `TaskRegistry.pruneExpiredTokens`; retention constants come from `ConfigurationManager`, never hardcoded in DAOs.
- Layer 2 (L0-only): import only `@edge-git/shared` + `@edge-git/backend-errors`; never `backend-runtime`, `git-*`, `backend-services`, or `apps/*` (enforced by `no-restricted-imports`).
