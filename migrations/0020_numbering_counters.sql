-- Atomic per-repo numbering counters (Slice 3 hardening).
-- Additive only. MAX(number)+1 readers race under concurrent POSTs; the 0019
-- UNIQUE indexes turn races into retried violations, but >3 concurrent
-- creators can still exhaust the 3-attempt loop. This table provides an
-- atomic allocator: a single UPSERT ... RETURNING statement hands out
-- distinct numbers (SQLite/D1 execute one statement atomically), seeded from
-- the current MAX(number) on first use so existing rows never collide.
-- Services fall back to the legacy MAX+1 loop when the table is absent
-- (legacy DBs, unit fakes); the UNIQUE indexes stay as the backstop.
CREATE TABLE IF NOT EXISTS repo_number_counters (
  repository_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  next_number INTEGER NOT NULL,
  PRIMARY KEY (repository_id, entity)
);
