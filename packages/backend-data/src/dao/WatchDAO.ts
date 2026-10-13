import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '@rexezuge/d1';

class WatchDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async watch(repoId: string, userEmail: string, now: number): Promise<void> {
    await this.run('INSERT OR IGNORE INTO repo_watches (repo_id, user_email, created_at) VALUES (?, ?, ?)', [repoId, userEmail, now]);
  }

  public async unwatch(repoId: string, userEmail: string): Promise<void> {
    await this.run('DELETE FROM repo_watches WHERE repo_id = ? AND user_email = ?', [repoId, userEmail]);
  }

  public async isWatching(repoId: string, userEmail: string): Promise<boolean> {
    const row = await this.database
      .prepare('SELECT repo_id FROM repo_watches WHERE repo_id = ? AND user_email = ? LIMIT 1')
      .bind(repoId, userEmail)
      .first<{ repo_id: string }>();
    return row !== null;
  }

  public async countByRepo(repoId: string): Promise<number> {
    const row = await this.database.prepare('SELECT COUNT(*) AS n FROM repo_watches WHERE repo_id = ?').bind(repoId).first<{ n: number }>();
    return row?.n ?? 0;
  }

  public async listWatchers(repoId: string, limit = 500): Promise<string[]> {
    const result = await this.database
      .prepare('SELECT user_email FROM repo_watches WHERE repo_id = ? LIMIT ?')
      .bind(repoId, limit)
      .all<{ user_email: string }>();
    return (result.results ?? []).map((r) => r.user_email);
  }

  public async listRepoIdsByUser(userEmail: string, limit = 200): Promise<string[]> {
    const result = await this.database
      .prepare('SELECT repo_id FROM repo_watches WHERE user_email = ? ORDER BY created_at DESC LIMIT ?')
      .bind(userEmail, limit)
      .all<{ repo_id: string }>();
    return (result.results ?? []).map((r) => r.repo_id);
  }

  public async deleteByRepo(repoId: string): Promise<void> {
    await this.run('DELETE FROM repo_watches WHERE repo_id = ?', [repoId]);
  }
}

export { WatchDAO };
