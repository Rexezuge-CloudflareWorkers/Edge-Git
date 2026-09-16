-- Edge-Git code search (v1): per-file content index at default-branch HEAD.
-- Additive only. Populated by web file writes (synchronous) and the search
-- backfill cron task (push catch-up). SearchDAO tries FTS5 first with LIKE
-- fallback, mirroring migration 0005.

CREATE TABLE IF NOT EXISTS code_index (
  repo_id TEXT NOT NULL,
  path TEXT NOT NULL,
  oid TEXT,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, path)
);
CREATE INDEX IF NOT EXISTS idx_code_index_repo ON code_index(repo_id);

CREATE VIRTUAL TABLE IF NOT EXISTS code_fts USING fts5(repo_id UNINDEXED, path, content, tokenize='porter');

CREATE TRIGGER IF NOT EXISTS trg_code_fts_ai AFTER INSERT ON code_index BEGIN
  INSERT INTO code_fts(repo_id, path, content) VALUES (NEW.repo_id, NEW.path, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_code_fts_ad AFTER DELETE ON code_index BEGIN
  DELETE FROM code_fts WHERE repo_id = OLD.repo_id AND path = OLD.path;
END;

CREATE TRIGGER IF NOT EXISTS trg_code_fts_au AFTER UPDATE ON code_index BEGIN
  DELETE FROM code_fts WHERE repo_id = OLD.repo_id AND path = OLD.path;
  INSERT INTO code_fts(repo_id, path, content) VALUES (NEW.repo_id, NEW.path, NEW.content);
END;
