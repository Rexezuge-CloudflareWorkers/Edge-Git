-- Edge-Git repo transfer (import/mirror/export provenance) + access hardening.
-- Additive only: keeps all prior columns for rollback.
--
-- Import model: a job records a validated public https git source URL.
-- The server fetches the remote advertisement + packfile over Smart HTTP
-- (no credentials are ever persisted — public sources only in v1) and
-- indexes the pack into the repo DO via `importPack`. Empty repos only.
CREATE TABLE IF NOT EXISTS repo_imports (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  refs_json TEXT,
  imported_refs INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_imports_repo ON repo_imports(repository_id);
CREATE INDEX IF NOT EXISTS idx_imports_status ON repo_imports(status);

-- Scheduled pull-mirror: at most one config per repo, fast-forward only.
-- External auth is one-shot (never stored); v1 mirrors public URLs.
CREATE TABLE IF NOT EXISTS repo_mirrors (
  repository_id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL DEFAULT 1440,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  last_status TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);

-- Deploy keys: per-repo git-only credentials (read default, optional
-- write). Hashes use a distinct `edge-git-deploy:` domain so a deploy key
-- can never authenticate as a user PAT and vice versa.
CREATE TABLE IF NOT EXISTS deploy_keys (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT,
  permission TEXT NOT NULL DEFAULT 'read',
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_deploy_keys_repo ON deploy_keys(repository_id);
CREATE INDEX IF NOT EXISTS idx_deploy_keys_hash ON deploy_keys(token_hash);

-- Fine-grained PAT scoping: an empty grant set means all repos the holder
-- can already see (legacy behavior). A non-empty set restricts the token
-- to the listed repos (intersected with repo/org permissions).
CREATE TABLE IF NOT EXISTS token_repo_grants (
  token_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (token_id, repository_id),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_token_grants_token ON token_repo_grants(token_id);

-- Per-repo push-time secret scanning mode: off|warn|block (default warn).
CREATE TABLE IF NOT EXISTS repo_security_settings (
  repository_id TEXT PRIMARY KEY,
  secret_scan_mode TEXT NOT NULL DEFAULT 'warn',
  updated_by TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);

-- Identifiable token prefix (first chars of the raw secret, safe to show).
-- NULL for legacy rows minted before prefixes existed.
ALTER TABLE user_access_tokens ADD COLUMN token_prefix TEXT;
