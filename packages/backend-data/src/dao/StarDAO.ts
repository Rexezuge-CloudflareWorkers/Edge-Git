import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '@rexezuge/d1';

class StarDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async star(repoId: string, userEmail: string, now: number): Promise<void> {
    await this.run('INSERT OR IGNORE INTO repo_stars (repo_id, user_email, created_at) VALUES (?, ?, ?)', [repoId, userEmail, now]);
  }

  public async unstar(repoId: string, userEmail: string): Promise<void> {
    await this.run('DELETE FROM repo_stars WHERE repo_id = ? AND user_email = ?', [repoId, userEmail]);
  }

  public async isStarred(repoId: string, userEmail: string): Promise<boolean> {
    const row = await this.database
      .prepare('SELECT repo_id FROM repo_stars WHERE repo_id = ? AND user_email = ? LIMIT 1')
      .bind(repoId, userEmail)
      .first<{ repo_id: string }>();
    return row !== null;
  }

  public async countByRepo(repoId: string): Promise<number> {
    const row = await this.database.prepare('SELECT COUNT(*) AS n FROM repo_stars WHERE repo_id = ?').bind(repoId).first<{ n: number }>();
    return row?.n ?? 0;
  }

  public async listRepoIdsByUser(userEmail: string, limit = 200): Promise<string[]> {
    const result = await this.database
      .prepare('SELECT repo_id FROM repo_stars WHERE user_email = ? ORDER BY created_at DESC LIMIT ?')
      .bind(userEmail, limit)
      .all<{ repo_id: string }>();
    return (result.results ?? []).map((r) => r.repo_id);
  }

  public async deleteByRepo(repoId: string): Promise<void> {
    await this.run('DELETE FROM repo_stars WHERE repo_id = ?', [repoId]);
  }
}

export { StarDAO };
