-- Edge-Git pull requests (v1): per-repo numbered PRs, reviews, comments.
-- Additive only: mirrors issues numbering (UNIQUE(repository_id, number)).

CREATE TABLE IF NOT EXISTS pull_requests (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed', 'merged')),
  base_branch TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  base_oid TEXT,
  head_oid TEXT,
  merge_base_oid TEXT,
  creator_email TEXT NOT NULL,
  merged_by TEXT,
  merged_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  UNIQUE (repository_id, number)
);
CREATE INDEX IF NOT EXISTS idx_pull_requests_repo ON pull_requests(repository_id);
CREATE INDEX IF NOT EXISTS idx_pull_requests_status ON pull_requests(repository_id, status);

CREATE TABLE IF NOT EXISTS pull_request_reviews (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL,
  author_email TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('approved', 'changes_requested', 'commented')),
  body TEXT,
  commit_oid TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (pull_request_id) REFERENCES pull_requests(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_pr ON pull_request_reviews(pull_request_id);

CREATE TABLE IF NOT EXISTS pull_request_comments (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL,
  author_email TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (pull_request_id) REFERENCES pull_requests(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pr_comments_pr ON pull_request_comments(pull_request_id);
