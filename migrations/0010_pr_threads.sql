-- Edge-Git PR depth part 2 (v1): inline review threads + review dismissal.
-- Additive only: two new tables plus nullable dismissal columns on
-- pull_request_reviews. Dismissed reviews are excluded from the merge gate
-- (`isBlockedByReviews` / approval quorum) but remain visible for audit.

CREATE TABLE IF NOT EXISTS pull_review_threads (
  id TEXT PRIMARY KEY,
  pull_request_id TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER,
  side TEXT NOT NULL DEFAULT 'new' CHECK(side IN ('old', 'new')),
  commit_oid TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
  author_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  resolved_by TEXT,
  resolved_at INTEGER,
  FOREIGN KEY (pull_request_id) REFERENCES pull_requests(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pr_threads_pr ON pull_review_threads(pull_request_id);
CREATE INDEX IF NOT EXISTS idx_pr_threads_status ON pull_review_threads(pull_request_id, status);

CREATE TABLE IF NOT EXISTS pull_thread_comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  author_email TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES pull_review_threads(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pr_thread_comments_thread ON pull_thread_comments(thread_id);

ALTER TABLE pull_request_reviews ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pull_request_reviews ADD COLUMN dismissed_by TEXT;
ALTER TABLE pull_request_reviews ADD COLUMN dismissed_at INTEGER;
ALTER TABLE pull_request_reviews ADD COLUMN dismiss_reason TEXT;
