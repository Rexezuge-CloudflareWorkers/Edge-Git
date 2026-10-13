import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '@rexezuge/d1';

interface DeletedRepoDoRow {
  do_key: string;
  full_name: string;
  repo_id: string;
  deleted_at: number;
  attempts: number;
}

// Tombstones for Durable Object storage that outlives its D1 row.
// Enqueued on repo delete/rename-source purge; consumed by the background
// `RepoVacuumTask`, which reclaims the REPO + CHECK_RUNNER isolate storage
// and KV read-model caches only while the canonical DO key still maps to no
// live repository (recreates win the race by design).
class DeletedRepoDoDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async enqueue(doKey: string, fullName: string, repoId: string, now: number): Promise<void> {
    await this.run('INSERT INTO deleted_repo_dos (do_key, full_name, repo_id, deleted_at, attempts) VALUES (?, ?, ?, ?, 0) ON CONFLICT (do_key) DO UPDATE SET full_name = excluded.full_name, repo_id = excluded.repo_id, deleted_at = excluded.deleted_at, attempts = 0', [doKey, fullName, repoId, now]);
  }

  public async listDue(olderThan: number, limit: number): Promise<DeletedRepoDoRow[]> {
    const result = await this.database
      .prepare('SELECT do_key, full_name, repo_id, deleted_at, attempts FROM deleted_repo_dos WHERE deleted_at <= ? ORDER BY deleted_at ASC LIMIT ?')
      .bind(olderThan, limit)
      .all<DeletedRepoDoRow>();
    return result.results ?? [];
  }

  public async recordAttempt(doKey: string): Promise<number> {
    const row = await this.database
      .prepare('UPDATE deleted_repo_dos SET attempts = attempts + 1 WHERE do_key = ? RETURNING attempts')
      .bind(doKey)
      .first<{ attempts: number }>()
      .catch(() => null);
    return row?.attempts ?? 0;
  }

  public async remove(doKey: string): Promise<void> {
    await this.run('DELETE FROM deleted_repo_dos WHERE do_key = ?', [doKey]);
  }
}

export { DeletedRepoDoDAO };
export type { DeletedRepoDoRow };
