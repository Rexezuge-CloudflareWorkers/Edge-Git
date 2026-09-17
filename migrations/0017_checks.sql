-- Edge-Git CI checks v1 (commit status checks + required-checks merge gate).
-- Additive only. D1 remains the source of truth for check runs; the
-- CheckRunnerWorker DO (one per repo) is the executor with 30s CPU per
-- invocation vs 10ms in the Worker, using alarms for retries/timeouts.
-- Free-plan budget: one DO RPC per push batches N contexts; D1 writes ~3-5
-- per push; logs live in DO SQLite, D1 holds conclusions only.

CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  context TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  conclusion TEXT,
  details_url TEXT,
  output_title TEXT,
  output_summary TEXT,
  creator_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  UNIQUE (repository_id, head_sha, context)
);
CREATE INDEX IF NOT EXISTS idx_check_runs_repo_sha ON check_runs(repository_id, head_sha);
CREATE INDEX IF NOT EXISTS idx_check_runs_status ON check_runs(status, updated_at);
