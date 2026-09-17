-- Edge-Git PR search (v1): FTS5 index for pull requests.
-- Additive only. Mirrors 0005_search.sql: SearchDAO tries FTS5 first and
-- falls back to LIKE when the underlying D1/fake does not support FTS5.

CREATE VIRTUAL TABLE IF NOT EXISTS pull_fts USING fts5(pull_id UNINDEXED, repo_id UNINDEXED, full_name, title, body, tokenize='porter');

-- Keep pull_fts in sync with pull_requests.
CREATE TRIGGER IF NOT EXISTS trg_pull_fts_ai AFTER INSERT ON pull_requests BEGIN
  INSERT INTO pull_fts(pull_id, repo_id, full_name, title, body)
  VALUES (NEW.id, NEW.repository_id, NEW.full_name, NEW.title, COALESCE(NEW.body, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_pull_fts_ad AFTER DELETE ON pull_requests BEGIN
  DELETE FROM pull_fts WHERE pull_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_pull_fts_au AFTER UPDATE ON pull_requests BEGIN
  DELETE FROM pull_fts WHERE pull_id = OLD.id;
  INSERT INTO pull_fts(pull_id, repo_id, full_name, title, body)
  VALUES (NEW.id, NEW.repository_id, NEW.full_name, NEW.title, COALESCE(NEW.body, ''));
END;

-- Backfill pre-existing rows (no-op when triggers already populated them;
-- guarded by NOT EXISTS so re-applying the migration stays idempotent).
INSERT INTO pull_fts(pull_id, repo_id, full_name, title, body)
SELECT id, repository_id, full_name, title, COALESCE(body, '')
FROM pull_requests
WHERE id NOT IN (SELECT pull_id FROM pull_fts);
