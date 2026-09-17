-- Edge-Git teams + audit log (v1): org-scoped teams with repo grants,
-- and an append-only audit trail for every /user/* call plus git pushes.
-- Additive only: all tables new, no ALTERs, safe rollback by table drop.
--
-- Teams: org-scoped workspaces (teams -> members -> repo grants). Roles
-- `admin|member` mirror AWS-AccessBridge team roles; repo grants reuse the
-- `admin|write|read` collaborator ranks so PermissionService can take the
-- max of direct and team-derived grants.
-- Audit: `audit_logs` mirrors the AWS-AccessBridge shape
-- (log_id, timestamp, user_email, action, resource, method, path,
-- status_code, detail, ip_address, user_agent) plus nullable org/repo
-- scoping columns (AccessBridge has a global superadmin tier; Edge-Git
-- scopes reads per-org because org owners are the top tier).

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  slug_ci TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  UNIQUE (org_id, slug_ci)
);
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(org_id);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_email),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_email);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);

CREATE TABLE IF NOT EXISTS team_repo_grants (
  team_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'write', 'read')),
  granted_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, repo_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_team_grants_repo ON team_repo_grants(repo_id);
CREATE INDEX IF NOT EXISTS idx_team_grants_team ON team_repo_grants(team_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  log_id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  user_email TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  detail TEXT,
  ip_address TEXT,
  user_agent TEXT,
  org_id TEXT,
  repo_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_email);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_user_timestamp ON audit_logs(user_email, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org_timestamp ON audit_logs(org_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_repo_timestamp ON audit_logs(repo_id, timestamp DESC);
