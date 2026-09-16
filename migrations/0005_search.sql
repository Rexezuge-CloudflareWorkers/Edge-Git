-- Edge-Git metadata search (v1): FTS5 indexes for repositories + issues.
-- Additive only. SearchDAO tries FTS5 first and falls back to LIKE when the
-- underlying D1/fake does not support FTS5, so this migration is safe to apply
-- everywhere real D1 runs (D1 supports FTS5).

CREATE VIRTUAL TABLE IF NOT EXISTS repo_fts USING fts5(repo_id UNINDEXED, full_name, description, tokenize='porter');

CREATE VIRTUAL TABLE IF NOT EXISTS issue_fts USING fts5(issue_id UNINDEXED, repo_id UNINDEXED, full_name, title, body, tokenize='porter');

-- Keep repo_fts in sync with repositories (full_name = owner/name).
CREATE TRIGGER IF NOT EXISTS trg_repo_fts_ai AFTER INSERT ON repositories BEGIN
  INSERT INTO repo_fts(repo_id, full_name, description)
  VALUES (NEW.id, NEW.owner || '/' || NEW.name, COALESCE(NEW.description, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_repo_fts_ad AFTER DELETE ON repositories BEGIN
  DELETE FROM repo_fts WHERE repo_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_repo_fts_au AFTER UPDATE ON repositories BEGIN
  DELETE FROM repo_fts WHERE repo_id = OLD.id;
  INSERT INTO repo_fts(repo_id, full_name, description)
  VALUES (NEW.id, NEW.owner || '/' || NEW.name, COALESCE(NEW.description, ''));
END;

-- Keep issue_fts in sync with issues.
CREATE TRIGGER IF NOT EXISTS trg_issue_fts_ai AFTER INSERT ON issues BEGIN
  INSERT INTO issue_fts(issue_id, repo_id, full_name, title, body)
  VALUES (NEW.id, NEW.repository_id, NEW.full_name, NEW.title, COALESCE(NEW.body, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_issue_fts_ad AFTER DELETE ON issues BEGIN
  DELETE FROM issue_fts WHERE issue_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_issue_fts_au AFTER UPDATE ON issues BEGIN
  DELETE FROM issue_fts WHERE issue_id = OLD.id;
  INSERT INTO issue_fts(issue_id, repo_id, full_name, title, body)
  VALUES (NEW.id, NEW.repository_id, NEW.full_name, NEW.title, COALESCE(NEW.body, ''));
END;

-- Backfill pre-existing rows (no-op when triggers already populated them;
-- guarded by NOT EXISTS so re-applying the migration stays idempotent).
INSERT INTO repo_fts(repo_id, full_name, description)
SELECT id, owner || '/' || name, COALESCE(description, '')
FROM repositories
WHERE id NOT IN (SELECT repo_id FROM repo_fts);

INSERT INTO issue_fts(issue_id, repo_id, full_name, title, body)
SELECT id, repository_id, full_name, title, COALESCE(body, '')
FROM issues
WHERE id NOT IN (SELECT issue_id FROM issue_fts);
