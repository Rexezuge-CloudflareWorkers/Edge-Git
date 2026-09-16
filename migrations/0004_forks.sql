-- Edge-Git forks + cross-fork pull requests (v1).
-- Additive only: fork lineage on repositories, head repo on pull requests.

ALTER TABLE repositories ADD COLUMN forked_from_repo_id TEXT REFERENCES repositories(id) ON DELETE SET NULL;
ALTER TABLE repositories ADD COLUMN forked_from_full_name TEXT;
CREATE INDEX IF NOT EXISTS idx_repositories_forked_from ON repositories(forked_from_repo_id);

ALTER TABLE pull_requests ADD COLUMN head_repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL;
ALTER TABLE pull_requests ADD COLUMN head_full_name TEXT;
CREATE INDEX IF NOT EXISTS idx_pull_requests_head_repo ON pull_requests(head_repository_id);
