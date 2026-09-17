-- Edge-Git releases + release assets (v1).
-- Additive only: all tables new, no ALTERs, safe for rollback by table drop.
--
-- Tags stay git-native in the RepoWorker DO (refs/tags/*). Releases are D1
-- metadata keyed by tag name (UNIQUE per repo) with draft/prerelease flags.
-- Drafts may exist before the git tag exists; publishing validates the tag
-- via the DO `getTags` RPC (best-effort, enforced in the service layer).
--
-- Asset bytes live in the RepoWorker DO filesystem
-- (`/release-assets/<releaseId>/<assetId>`, inside the 5GB dofs device),
-- NOT in D1. D1 holds metadata only (name, size, content_type, sha256).

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  is_draft INTEGER NOT NULL DEFAULT 1,
  is_prerelease INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  UNIQUE (repository_id, tag_name)
);
CREATE INDEX IF NOT EXISTS idx_releases_repo ON releases(repository_id);
CREATE INDEX IF NOT EXISTS idx_releases_repo_published ON releases(repository_id, published_at DESC);

CREATE TABLE IF NOT EXISTS release_assets (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  sha256 TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE,
  UNIQUE (release_id, name)
);
CREATE INDEX IF NOT EXISTS idx_release_assets_release ON release_assets(release_id);
CREATE INDEX IF NOT EXISTS idx_release_assets_repo ON release_assets(repository_id);
