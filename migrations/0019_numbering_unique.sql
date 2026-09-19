-- Hardening: UNIQUE guards for concurrent numbering + import single-flight.
-- Additive only. The MAX(number)+1 readers in Issue/Pull/Discussion/Project
-- DAOs race under concurrent POSTs; these constraints turn the race into a
-- catchable UNIQUE violation that services retry (3 attempts).
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_repo_number ON issues(repository_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pulls_repo_number ON pull_requests(repository_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_discussions_repo_number ON discussions(repository_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_repo_number ON projects(repository_id, number);

-- Import single-flight stays service-level (check-then-create +
-- UNIQUE-violation catch on retry): a plain UNIQUE(repository_id, status)
-- would forbid lawful history (multiple done/failed rows), and partial
-- WHERE-status indexes are not portable across D1 builds, so no index here.
