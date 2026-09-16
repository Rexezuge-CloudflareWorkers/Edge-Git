import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';

export type RepoRole = 'admin' | 'write' | 'read';

export interface RepoCollaboratorRow {
  repo_id: string;
  user_email: string;
  role: RepoRole;
  granted_by: string | null;
  created_at: number;
}

class RepoCollaboratorDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async upsert(repoId: string, userEmail: string, role: RepoRole, grantedBy: string | null, now: number): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare(
            'INSERT INTO repo_collaborators (repo_id, user_email, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(repo_id, user_email) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by',
          )
          .bind(repoId, userEmail, role, grantedBy, now)
          .run(),
      'upsert repo collaborator',
    );
  }

  public async get(repoId: string, userEmail: string): Promise<RepoCollaboratorRow | null> {
    return this.database
      .prepare('SELECT * FROM repo_collaborators WHERE repo_id = ? AND user_email = ? LIMIT 1')
      .bind(repoId, userEmail)
      .first<RepoCollaboratorRow>();
  }

  public async listByRepo(repoId: string, limit = 200): Promise<RepoCollaboratorRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM repo_collaborators WHERE repo_id = ? ORDER BY created_at ASC LIMIT ?')
      .bind(repoId, limit)
      .all<RepoCollaboratorRow>();
    return result.results ?? [];
  }

  public async listByUser(userEmail: string, limit = 500): Promise<RepoCollaboratorRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM repo_collaborators WHERE user_email = ? ORDER BY created_at DESC LIMIT ?')
      .bind(userEmail, limit)
      .all<RepoCollaboratorRow>();
    return result.results ?? [];
  }

  public async remove(repoId: string, userEmail: string): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM repo_collaborators WHERE repo_id = ? AND user_email = ?').bind(repoId, userEmail).run(),
      'remove repo collaborator',
    );
  }

  public async deleteByRepo(repoId: string): Promise<void> {
    await this.withRetry(() => this.database.prepare('DELETE FROM repo_collaborators WHERE repo_id = ?').bind(repoId).run(), 'delete collaborators by repo');
  }
}

export { RepoCollaboratorDAO };
