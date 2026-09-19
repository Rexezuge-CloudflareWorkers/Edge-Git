-- Edge-Git code search (v2): rowid-linked FTS maintenance.
-- Additive in effect, rebuild in mechanism. The v1 triggers deleted FTS rows
-- by (repo_id, path), which FTS5 cannot resolve by index: every code_index
-- write paid a full FTS scan (~250 D1 rows-read per upsert, the dominant
-- cost behind the 5M/day rows-read budget).
--
-- code_index is a rowid table, so link each FTS row to its source row by
-- rowid: maintenance becomes point lookups. The (repo_id, path) columns stay
-- for query scoping; only trigger addressing changes. ON CONFLICT DO UPDATE
-- preserves rowid, so links survive rewrites.
-- Runs once; the rebuild cost is proportional to code_index size.

DROP TRIGGER IF EXISTS trg_code_fts_ai;
DROP TRIGGER IF EXISTS trg_code_fts_ad;
DROP TRIGGER IF EXISTS trg_code_fts_au;

CREATE VIRTUAL TABLE IF NOT EXISTS code_fts_new USING fts5(repo_id UNINDEXED, path, content, tokenize='porter');

INSERT INTO code_fts_new(rowid, repo_id, path, content) SELECT rowid, repo_id, path, content FROM code_index;

DROP TABLE IF EXISTS code_fts;

ALTER TABLE code_fts_new RENAME TO code_fts;

CREATE TRIGGER IF NOT EXISTS trg_code_fts_ai AFTER INSERT ON code_index BEGIN
  INSERT INTO code_fts(rowid, repo_id, path, content) VALUES (NEW.rowid, NEW.repo_id, NEW.path, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_code_fts_ad AFTER DELETE ON code_index BEGIN
  DELETE FROM code_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER IF NOT EXISTS trg_code_fts_au AFTER UPDATE ON code_index BEGIN
  DELETE FROM code_fts WHERE rowid = OLD.rowid;
  INSERT INTO code_fts(rowid, repo_id, path, content) VALUES (NEW.rowid, NEW.repo_id, NEW.path, NEW.content);
END;
