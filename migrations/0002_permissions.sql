-- Edge-Git permissions model (v1): global username namespace, organizations, collaborators.
-- Additive only: keeps 0001 columns for rollback; app code backfills/reads new columns.

-- Users gain a mutable globally-unique username (login stays email via Zero Trust).
ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN updated_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_ci ON users(username);

-- Global namespace registry: enforces that a user username and an org username
-- can never collide (GitHub-style `/:owner`). username_ci is lower(username).
CREATE TABLE IF NOT EXISTS namespaces (
  username_ci TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('user', 'org')),
  user_email TEXT,
  org_id TEXT,
  created_at INTEGER NOT NULL
);

-- Organizations (individuals create them; members are individuals by email).
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_ci TEXT NOT NULL UNIQUE,
  display_name TEXT,
  creator_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_members (
  org_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner', 'member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_email),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_email);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(org_id);

-- Per-repo grants for org members and outside collaborators.
-- Minimal v1 roles: admin | write | read.
CREATE TABLE IF NOT EXISTS repo_collaborators (
  repo_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'write', 'read')),
  granted_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, user_email),
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_repo_collab_user ON repo_collaborators(user_email);
CREATE INDEX IF NOT EXISTS idx_repo_collab_repo ON repo_collaborators(repo_id);

-- Repositories gain an explicit owner type + case-insensitive lookup columns.
-- Legacy (owner, owner_email, name) rows stay readable; new writes populate both.
ALTER TABLE repositories ADD COLUMN owner_type TEXT DEFAULT 'user';
ALTER TABLE repositories ADD COLUMN owner_ci TEXT;
ALTER TABLE repositories ADD COLUMN name_ci TEXT;
ALTER TABLE repositories ADD COLUMN owner_user_email TEXT;
ALTER TABLE repositories ADD COLUMN org_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_owner_ci_name_ci ON repositories(owner_ci, name_ci);
CREATE INDEX IF NOT EXISTS idx_repositories_org ON repositories(org_id);
