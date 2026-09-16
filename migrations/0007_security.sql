-- Edge-Git scoped tokens + branch protection (v1).
-- Additive only: keeps all prior columns for rollback.

-- PAT scopes: JSON array of TokenScope ('repo:read' | 'repo:write' | 'admin').
-- NULL/legacy rows mean full access (all three scopes) for backward
-- compatibility. New tokens always write an explicit array.
ALTER TABLE user_access_tokens ADD COLUMN scopes TEXT NOT NULL DEFAULT '["repo:read","repo:write","admin"]';

-- Branch protection rules: one row per (repo, pattern). Patterns are exact
-- branch names or `*` globs (e.g. `release/*`); longest match wins.
-- require_status_checks is stored-but-ignored in v1 (no CI yet) so rule
-- payloads stay forward-compatible once checks exist.
CREATE TABLE IF NOT EXISTS branch_protection_rules (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  require_pr INTEGER NOT NULL DEFAULT 0,
  required_approvals INTEGER NOT NULL DEFAULT 0,
  block_force_push INTEGER NOT NULL DEFAULT 1,
  block_deletion INTEGER NOT NULL DEFAULT 1,
  require_status_checks TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  UNIQUE (repository_id, pattern)
);
CREATE INDEX IF NOT EXISTS idx_branch_rules_repo ON branch_protection_rules(repository_id);
