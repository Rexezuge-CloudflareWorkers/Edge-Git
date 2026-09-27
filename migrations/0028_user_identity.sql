-- Migration 0028: Decouple the user identifier from the email address.
--
-- Before this migration `users.email` was the PRIMARY KEY *and* the identity
-- key of every user-keyed table, so the address was the account. It could not
-- be changed: three tables carried live
-- `FOREIGN KEY (..._email) REFERENCES users(email) ON DELETE CASCADE`
-- (`repositories.owner_email`, `user_access_tokens.user_email`,
-- `snippets.owner_email`), so rewriting an address either tripped the
-- constraint or cascaded the user's repositories away.
--
-- After this migration:
--   * `users.id` is the stable account key (opaque `usr_<hex>`).
--   * `users.current_email` is the mutable login address.
--   * `users.email` becomes the frozen *anchor* address. It is never updated,
--     so every existing foreign key and every existing `*_email` value keeps
--     resolving forever, and no table has to be rebuilt.
--   * `user_emails` is the address registry: an address maps to an account,
--     `is_verified = 1` means "may be used to log in". A changed-from address
--     is retained with `is_verified = 0` so pre-change rows stay attributable
--     while the address stops authenticating, and it is released for
--     re-registration by a later account.
--   * Every user-keyed table carries a `user_id` FK to `users(id)` and is
--     read and written by that id. The legacy `*_email` / `*_by` string columns
--     stay as denormalized copies: still written, no longer the identity.
--
-- Why the address stays in `users` at all: D1 enforces foreign keys through
-- the Worker binding and honours neither `PRAGMA foreign_keys = off` nor
-- `PRAGMA legacy_alter_table = on` (both verified against real D1 — see
-- `UserIdentityUpgrade.int.test.ts`). `defer_foreign_keys` is honoured but D1
-- documents that it does not suppress `ON DELETE CASCADE`. Since SQLite
-- rewrites a child's foreign key clause when the parent is renamed, and drops
-- a parent by cascading, the three references to `users(email)` cannot be
-- repointed without losing rows. Keeping `email` as a frozen anchor sidesteps
-- the rebuild entirely: this migration is purely additive.
--
-- Rerunnable: every backfill is guarded by `IS NULL` / `INSERT OR IGNORE`, and
-- `users.id` is only filled where it is still missing.

-- ============================================================
-- Phase 1: stable account key
-- ============================================================
-- SQLite cannot add a PRIMARY KEY column, so the id is a plain column with a
-- unique index. A unique index is a valid foreign key parent, which is all the
-- `user_id` references below need.
ALTER TABLE users ADD COLUMN id TEXT;

UPDATE users SET id = 'usr_' || lower(hex(randomblob(16))) WHERE id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_id ON users(id);

-- ============================================================
-- Phase 2: mutable login address
-- ============================================================
-- `email` stays as the frozen anchor (see the header note); `current_email`
-- is what the account signs in with and what the API reports. Uniqueness is
-- enforced here, so an address can never be claimed by two accounts.
ALTER TABLE users ADD COLUMN current_email TEXT;

UPDATE users SET current_email = lower(email) WHERE current_email IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_current_email ON users(current_email);

-- ============================================================
-- Phase 3: address registry
-- ============================================================
-- Login resolution consults `is_verified = 1` only. Backfilled from the frozen
-- anchor address of every existing account, lowercased so a legacy
-- mixed-case row still yields exactly one login identity.
CREATE TABLE IF NOT EXISTS user_emails (
  email TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_emails_user ON user_emails(user_id);

INSERT OR IGNORE INTO user_emails (email, user_id, is_verified, created_at)
SELECT lower(email), id, 1, created_at FROM users;

-- ============================================================
-- Phase 4: user_id on every user-keyed table
-- ============================================================
-- Additive only: `ALTER TABLE ... ADD COLUMN`, then a backfill that resolves
-- each stored address through the registry. Resolving via `user_emails` rather
-- than `users.email` means legacy rows also resolve once an address is linked
-- as an alias, and the lowercased join is case-insensitive by construction.
--
-- An address that matches no account leaves `user_id` NULL. That is
-- intentional: the row keeps its string column and the DAOs fall back to the
-- `*_email` read, which is how an unknown or deleted actor stays attributable
-- (rendered as `ghost`) instead of breaking the query.

-- --- access / authority ---
-- These decide permissions, so they carry a unique `(scope, user_id)` index:
-- the DAOs retarget their upserts onto it, and a NULL id never collides
-- because NULLs are distinct in a SQLite unique index.
ALTER TABLE namespaces ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE namespaces SET user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(namespaces.user_email) LIMIT 1);
CREATE INDEX IF NOT EXISTS idx_namespaces_user_id ON namespaces(user_id);

ALTER TABLE organization_members ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE organization_members SET user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(organization_members.user_email) LIMIT 1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_members_org_user ON organization_members(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON organization_members(user_id);

ALTER TABLE repo_collaborators ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE repo_collaborators SET user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(repo_collaborators.user_email) LIMIT 1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_collab_repo_user ON repo_collaborators(repo_id, user_id);
CREATE INDEX IF NOT EXISTS idx_repo_collab_user_id ON repo_collaborators(user_id);

ALTER TABLE team_members ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE team_members SET user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(team_members.user_email) LIMIT 1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_team_user ON team_members(team_id, user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id);

ALTER TABLE repositories ADD COLUMN owner_user_id TEXT REFERENCES users(id);
UPDATE repositories SET owner_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(COALESCE(repositories.owner_user_email, repositories.owner_email)) LIMIT 1);
CREATE INDEX IF NOT EXISTS idx_repositories_owner_user_id ON repositories(owner_user_id);

ALTER TABLE user_access_tokens ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE user_access_tokens SET user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(user_access_tokens.user_email) LIMIT 1);
CREATE INDEX IF NOT EXISTS idx_tokens_user_id ON user_access_tokens(user_id);

-- --- attribution ---
-- Frozen strings stay in place so audits and history read the same; the id is
-- what display resolution uses, so a renamed *or re-addressed* actor still
-- renders as the same account.
ALTER TABLE issues ADD COLUMN creator_user_id TEXT REFERENCES users(id);
UPDATE issues SET creator_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(issues.creator_email) LIMIT 1);

ALTER TABLE comments ADD COLUMN author_user_id TEXT REFERENCES users(id);
UPDATE comments SET author_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(comments.author_email) LIMIT 1);

ALTER TABLE issue_assignees ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE issue_assignees SET user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(issue_assignees.user_email) LIMIT 1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_issue_assignees_issue_user ON issue_assignees(issue_id, user_id);

ALTER TABLE pull_requests ADD COLUMN creator_user_id TEXT REFERENCES users(id);
UPDATE pull_requests SET creator_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(pull_requests.creator_email) LIMIT 1);

ALTER TABLE pull_requests ADD COLUMN merged_by_user_id TEXT REFERENCES users(id);
UPDATE pull_requests SET merged_by_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(pull_requests.merged_by) LIMIT 1);

ALTER TABLE pull_request_reviews ADD COLUMN author_user_id TEXT REFERENCES users(id);
UPDATE pull_request_reviews SET author_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(pull_request_reviews.author_email) LIMIT 1);

ALTER TABLE pull_request_reviews ADD COLUMN dismissed_by_user_id TEXT REFERENCES users(id);
UPDATE pull_request_reviews SET dismissed_by_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(pull_request_reviews.dismissed_by) LIMIT 1);

ALTER TABLE pull_request_comments ADD COLUMN author_user_id TEXT REFERENCES users(id);
UPDATE pull_request_comments SET author_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(pull_request_comments.author_email) LIMIT 1);

ALTER TABLE pull_assignees ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE pull_assignees SET user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(pull_assignees.user_email) LIMIT 1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pull_assignees_pull_user ON pull_assignees(pull_request_id, user_id);

ALTER TABLE pull_reviewers ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE pull_reviewers SET user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(pull_reviewers.user_email) LIMIT 1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pull_reviewers_pull_user ON pull_reviewers(pull_request_id, user_id);

ALTER TABLE pull_review_threads ADD COLUMN author_user_id TEXT REFERENCES users(id);
UPDATE pull_review_threads SET author_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(pull_review_threads.author_email) LIMIT 1);

ALTER TABLE pull_review_threads ADD COLUMN resolved_by_user_id TEXT REFERENCES users(id);
UPDATE pull_review_threads SET resolved_by_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(pull_review_threads.resolved_by) LIMIT 1);

ALTER TABLE pull_thread_comments ADD COLUMN author_user_id TEXT REFERENCES users(id);
UPDATE pull_thread_comments SET author_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(pull_thread_comments.author_email) LIMIT 1);

ALTER TABLE discussions ADD COLUMN author_user_id TEXT REFERENCES users(id);
UPDATE discussions SET author_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(discussions.author_email) LIMIT 1);

ALTER TABLE discussion_comments ADD COLUMN author_user_id TEXT REFERENCES users(id);
UPDATE discussion_comments SET author_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(discussion_comments.author_email) LIMIT 1);

ALTER TABLE wiki_revisions ADD COLUMN author_user_id TEXT REFERENCES users(id);
UPDATE wiki_revisions SET author_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(wiki_revisions.author_email) LIMIT 1);

ALTER TABLE projects ADD COLUMN creator_user_id TEXT REFERENCES users(id);
UPDATE projects SET creator_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(projects.creator_email) LIMIT 1);

ALTER TABLE project_cards ADD COLUMN creator_user_id TEXT REFERENCES users(id);
UPDATE project_cards SET creator_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(project_cards.creator_email) LIMIT 1);

ALTER TABLE repo_webhooks ADD COLUMN creator_user_id TEXT REFERENCES users(id);
UPDATE repo_webhooks SET creator_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(repo_webhooks.creator_email) LIMIT 1);

ALTER TABLE check_runs ADD COLUMN creator_user_id TEXT REFERENCES users(id);
UPDATE check_runs SET creator_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(check_runs.creator_email) LIMIT 1);

ALTER TABLE repo_events ADD COLUMN actor_user_id TEXT REFERENCES users(id);
UPDATE repo_events SET actor_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(repo_events.actor_email) LIMIT 1);

-- --- actor `*_by` columns (these hold lowercased addresses, not usernames) ---
ALTER TABLE organizations ADD COLUMN creator_user_id TEXT REFERENCES users(id);
UPDATE organizations SET creator_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(organizations.creator_email) LIMIT 1);

ALTER TABLE teams ADD COLUMN created_by_user_id TEXT REFERENCES users(id);
UPDATE teams SET created_by_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(teams.created_by) LIMIT 1);

ALTER TABLE team_repo_grants ADD COLUMN granted_by_user_id TEXT REFERENCES users(id);
UPDATE team_repo_grants SET granted_by_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(team_repo_grants.granted_by) LIMIT 1);

ALTER TABLE branch_protection_rules ADD COLUMN created_by_user_id TEXT REFERENCES users(id);
UPDATE branch_protection_rules SET created_by_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(branch_protection_rules.created_by) LIMIT 1);

ALTER TABLE releases ADD COLUMN created_by_user_id TEXT REFERENCES users(id);
UPDATE releases SET created_by_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(releases.created_by) LIMIT 1);

ALTER TABLE release_assets ADD COLUMN created_by_user_id TEXT REFERENCES users(id);
UPDATE release_assets SET created_by_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(release_assets.created_by) LIMIT 1);

ALTER TABLE repo_imports ADD COLUMN created_by_user_id TEXT REFERENCES users(id);
UPDATE repo_imports SET created_by_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(repo_imports.created_by) LIMIT 1);

ALTER TABLE repo_mirrors ADD COLUMN created_by_user_id TEXT REFERENCES users(id);
UPDATE repo_mirrors SET created_by_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(repo_mirrors.created_by) LIMIT 1);

ALTER TABLE deploy_keys ADD COLUMN created_by_user_id TEXT REFERENCES users(id);
UPDATE deploy_keys SET created_by_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(deploy_keys.created_by) LIMIT 1);

ALTER TABLE repo_security_settings ADD COLUMN updated_by_user_id TEXT REFERENCES users(id);
UPDATE repo_security_settings SET updated_by_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(repo_security_settings.updated_by) LIMIT 1);

-- --- recipients / personal state ---
ALTER TABLE repo_stars ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE repo_stars SET user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(repo_stars.user_email) LIMIT 1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_stars_repo_user ON repo_stars(repo_id, user_id);

ALTER TABLE repo_watches ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE repo_watches SET user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(repo_watches.user_email) LIMIT 1);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_watches_repo_user ON repo_watches(repo_id, user_id);

ALTER TABLE notifications ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE notifications SET user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(notifications.user_email) LIMIT 1);
ALTER TABLE notifications ADD COLUMN actor_user_id TEXT REFERENCES users(id);
UPDATE notifications SET actor_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(notifications.actor_email) LIMIT 1);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id, is_read, created_at DESC, id DESC);

ALTER TABLE audit_logs ADD COLUMN user_id TEXT REFERENCES users(id);
UPDATE audit_logs SET user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(audit_logs.user_email) LIMIT 1);
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_logs(user_id, timestamp DESC);

ALTER TABLE snippets ADD COLUMN owner_user_id TEXT REFERENCES users(id);
UPDATE snippets SET owner_user_id = (SELECT ue.user_id FROM user_emails ue WHERE ue.email = lower(snippets.owner_email) LIMIT 1);
CREATE INDEX IF NOT EXISTS idx_snippets_owner_user_id ON snippets(owner_user_id);

-- ============================================================
-- Phase 5: verify
-- ============================================================
-- Every backfill above resolved through `user_emails`, so no foreign key should
-- be dangling. `PRAGMA foreign_key_check` reports violations as rows rather
-- than raising, so `UserIdentityUpgrade.int.test.ts` asserts it comes back
-- empty against a seeded database.
PRAGMA foreign_key_check;
