-- Edge-Git social + notifications (v1): stars, watches, activity events, inbox.
-- Additive only: all tables new, no ALTERs, safe for rollback by table drop.

CREATE TABLE IF NOT EXISTS repo_stars (
  repo_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, user_email),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_repo_stars_user ON repo_stars(user_email);
CREATE INDEX IF NOT EXISTS idx_repo_stars_repo ON repo_stars(repo_id);

CREATE TABLE IF NOT EXISTS repo_watches (
  repo_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, user_email),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_repo_watches_user ON repo_watches(user_email);
CREATE INDEX IF NOT EXISTS idx_repo_watches_repo ON repo_watches(repo_id);

-- Append-only activity log per repo. subject_number covers issue/PR numbers;
-- subject_oid covers push head OIDs; payload is small JSON (titles, counts).
CREATE TABLE IF NOT EXISTS repo_events (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('repo_created','push','issue_opened','issue_closed','issue_reopened','issue_commented','pr_opened','pr_closed','pr_merged','pr_reviewed','pr_commented','fork_created')),
  subject_type TEXT,
  subject_number INTEGER,
  subject_oid TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_repo_events_repo_time ON repo_events(repository_id, created_at DESC, id DESC);

-- Per-user inbox fanned out from events. Unread rows are never auto-pruned;
-- read rows expire via the social pruning cron task.
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  repository_id TEXT,
  full_name TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  subject_type TEXT,
  subject_number INTEGER,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_email, is_read, created_at DESC, id DESC);
