-- Edge-Git initial schema: users, repos, PATs, issues, comments
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_private INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_email) REFERENCES users(email) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_owner_name ON repositories(owner, name);
CREATE INDEX IF NOT EXISTS idx_repositories_owner_email ON repositories(owner_email);

CREATE TABLE IF NOT EXISTS user_access_tokens (
  token_id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON user_access_tokens(user_email);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON user_access_tokens(token_hash);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  creator_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  UNIQUE (repository_id, number)
);
CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repository_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT,
  author_email TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);
