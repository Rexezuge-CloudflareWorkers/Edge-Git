-- Edge-Git collaboration surfaces (v1): projects, discussions, wiki, snippets.
-- Additive only: all tables new, no ALTERs on existing tables, safe for
-- rollback by table drop. Workers-native: D1 metadata only, no new bindings.
--
-- Projects: repo-level kanban (project -> columns -> cards). Cards link to
-- issues/pulls by id snapshot or carry a free-form note.
-- Discussions: repo forum with seeded categories, numbered threads, comments.
-- Wiki: D1-backed markdown pages with revision history and optimistic
-- concurrency (expectedRevision in the service layer, mirrors expectedOid).
-- Snippets: user-scoped multi-file text snippets (gist-lite), public/secret.

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
  creator_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  UNIQUE (repository_id, number)
);
CREATE INDEX IF NOT EXISTS idx_projects_repo ON projects(repository_id);

CREATE TABLE IF NOT EXISTS project_columns (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, title)
);
CREATE INDEX IF NOT EXISTS idx_project_columns_project ON project_columns(project_id);

CREATE TABLE IF NOT EXISTS project_cards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  column_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note' CHECK(kind IN ('note', 'issue', 'pull')),
  note_title TEXT,
  note_body TEXT,
  issue_id TEXT,
  pull_request_id TEXT,
  position REAL NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  creator_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (column_id) REFERENCES project_columns(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_cards_project ON project_cards(project_id);
CREATE INDEX IF NOT EXISTS idx_project_cards_column ON project_cards(column_id);

CREATE TABLE IF NOT EXISTS discussion_categories (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  kind TEXT NOT NULL DEFAULT 'general' CHECK(kind IN ('general', 'qa', 'announcement', 'ideas')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  UNIQUE (repository_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_discussion_categories_repo ON discussion_categories(repository_id);

CREATE TABLE IF NOT EXISTS discussions (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  category_id TEXT,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  author_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'locked', 'answered')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES discussion_categories(id) ON DELETE SET NULL,
  UNIQUE (repository_id, number)
);
CREATE INDEX IF NOT EXISTS idx_discussions_repo ON discussions(repository_id);
CREATE INDEX IF NOT EXISTS idx_discussions_category ON discussions(category_id);

CREATE TABLE IF NOT EXISTS discussion_comments (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL,
  author_email TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (discussion_id) REFERENCES discussions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_discussion_comments_discussion ON discussion_comments(discussion_id);

CREATE TABLE IF NOT EXISTS wiki_pages (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  UNIQUE (repository_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_wiki_pages_repo ON wiki_pages(repository_id);

CREATE TABLE IF NOT EXISTS wiki_revisions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  author_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (page_id) REFERENCES wiki_pages(id) ON DELETE CASCADE,
  UNIQUE (page_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_wiki_revisions_page ON wiki_revisions(page_id);

CREATE TABLE IF NOT EXISTS snippets (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public' CHECK(visibility IN ('public', 'secret')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_email) REFERENCES users(email) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_snippets_owner ON snippets(owner_email);
CREATE INDEX IF NOT EXISTS idx_snippets_visibility ON snippets(visibility);

CREATE TABLE IF NOT EXISTS snippet_files (
  id TEXT PRIMARY KEY,
  snippet_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (snippet_id) REFERENCES snippets(id) ON DELETE CASCADE,
  UNIQUE (snippet_id, filename)
);
CREATE INDEX IF NOT EXISTS idx_snippet_files_snippet ON snippet_files(snippet_id);

-- FTS5 for discussions + snippets (same pattern as 0005_search.sql).
-- SearchDAO tries FTS5 first and falls back to LIKE, so fakes/old D1 stay safe.
CREATE VIRTUAL TABLE IF NOT EXISTS discussion_fts USING fts5(discussion_id UNINDEXED, repo_id UNINDEXED, title, body, tokenize='porter');

CREATE VIRTUAL TABLE IF NOT EXISTS snippet_fts USING fts5(snippet_id UNINDEXED, title, body, tokenize='porter');

CREATE TRIGGER IF NOT EXISTS trg_discussion_fts_ai AFTER INSERT ON discussions BEGIN
  INSERT INTO discussion_fts(discussion_id, repo_id, title, body)
  VALUES (NEW.id, NEW.repository_id, NEW.title, COALESCE(NEW.body, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_discussion_fts_ad AFTER DELETE ON discussions BEGIN
  DELETE FROM discussion_fts WHERE discussion_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_discussion_fts_au AFTER UPDATE ON discussions BEGIN
  DELETE FROM discussion_fts WHERE discussion_id = OLD.id;
  INSERT INTO discussion_fts(discussion_id, repo_id, title, body)
  VALUES (NEW.id, NEW.repository_id, NEW.title, COALESCE(NEW.body, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_snippet_fts_ai AFTER INSERT ON snippets BEGIN
  INSERT INTO snippet_fts(snippet_id, title, body)
  VALUES (NEW.id, NEW.title, '');
END;

CREATE TRIGGER IF NOT EXISTS trg_snippet_fts_ad AFTER DELETE ON snippets BEGIN
  DELETE FROM snippet_fts WHERE snippet_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_snippet_fts_au AFTER UPDATE ON snippets BEGIN
  DELETE FROM snippet_fts WHERE snippet_id = OLD.id;
  INSERT INTO snippet_fts(snippet_id, title, body)
  VALUES (NEW.id, NEW.title, '');
END;

INSERT INTO discussion_fts(discussion_id, repo_id, title, body)
SELECT id, repository_id, title, COALESCE(body, '')
FROM discussions
WHERE id NOT IN (SELECT discussion_id FROM discussion_fts);

INSERT INTO snippet_fts(snippet_id, title, body)
SELECT id, title, ''
FROM snippets
WHERE id NOT IN (SELECT snippet_id FROM snippet_fts);
