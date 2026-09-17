-- Edge-Git collaboration depth (v1): labels, milestones, assignees, reviewers, drafts.
-- Additive only: all tables new except additive columns on issues/pull_requests.

CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'ededed',
  description TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  UNIQUE (repository_id, name)
);
CREATE INDEX IF NOT EXISTS idx_labels_repo ON labels(repository_id);

CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  due_on INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_milestones_repo ON milestones(repository_id);

CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (issue_id, label_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS issue_assignees (
  issue_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (issue_id, user_email),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pull_labels (
  pull_request_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (pull_request_id, label_id),
  FOREIGN KEY (pull_request_id) REFERENCES pull_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pull_assignees (
  pull_request_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pull_request_id, user_email),
  FOREIGN KEY (pull_request_id) REFERENCES pull_requests(id) ON DELETE CASCADE
);

-- Requested reviewers with lightweight status tracking.
CREATE TABLE IF NOT EXISTS pull_reviewers (
  pull_request_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'changes_requested')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pull_request_id, user_email),
  FOREIGN KEY (pull_request_id) REFERENCES pull_requests(id) ON DELETE CASCADE
);

ALTER TABLE issues ADD COLUMN milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL;
ALTER TABLE pull_requests ADD COLUMN milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL;
ALTER TABLE pull_requests ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0;
