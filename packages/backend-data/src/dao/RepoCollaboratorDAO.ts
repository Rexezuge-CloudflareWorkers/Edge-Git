import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';

export type RepoRole = 'admin' | 'write' | 'read';

export interface RepoCollaboratorRow {
  repo_id: string;
  user_email: string;
  /**
  Account key (0028). NULL only for rows written before the migration.
  */
  user_id?: string | null;
  role: RepoRole;
  granted_by: string | null;
  created_at: number;
}

class RepoCollaboratorDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  /**
   * `userEmail` is the account's frozen anchor (what legacy rows and the
   * foreign key store); `userId` is what the grant is keyed on, so a
   * collaborator keeps access after changing their address.
   */
  public async upsert(repoId: string, userEmail: string, role: RepoRole, grantedBy: string | null, now: number, userId?: string | null): Promise<void> {
    const normalized = userEmail.toLowerCase();
    const normalizedGrant = grantedBy?.toLowerCase() ?? null;
    await this.withRetry(async () => {
      await this.database
        .prepare('DELETE FROM repo_collaborators WHERE repo_id = ? AND lower(user_email) = ? AND user_email != ?')
        .bind(repoId, normalized, normalized)
        .run()
        .catch(() => undefined);
      return this.database
        .prepare(
          'INSERT INTO repo_collaborators (repo_id, user_email, role, granted_by, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(repo_id, user_email) DO UPDATE SET role = excluded.role, granted_by = excluded.granted_by, user_id = COALESCE(excluded.user_id, repo_collaborators.user_id)',
        )
        .bind(repoId, normalized, role, normalizedGrant, now, userId ?? null)
        .run();
    }, 'upsert repo collaborator');
  }

  public async get(repoId: string, userEmail: string): Promise<RepoCollaboratorRow | null> {
    return this.database
      .prepare('SELECT * FROM repo_collaborators WHERE repo_id = ? AND lower(user_email) = lower(?) LIMIT 1')
      .bind(repoId, userEmail)
      .first<RepoCollaboratorRow>();
  }

  /**
  Grant read by account key. Authoritative once 0028 has backfilled.
  */
  public async getByUserId(repoId: string, userId: string): Promise<RepoCollaboratorRow | null> {
    return this.database
      .prepare('SELECT * FROM repo_collaborators WHERE repo_id = ? AND user_id = ? LIMIT 1')
      .bind(repoId, userId)
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
      .prepare('SELECT * FROM repo_collaborators WHERE lower(user_email) = lower(?) ORDER BY created_at DESC LIMIT ?')
      .bind(userEmail, limit)
      .all<RepoCollaboratorRow>();
    return result.results ?? [];
  }

  /**
  Grants held by an account, resolved by key so an address change is survivable.
  */
  public async listByUserId(userId: string, limit = 500): Promise<RepoCollaboratorRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM repo_collaborators WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
      .bind(userId, limit)
      .all<RepoCollaboratorRow>();
    return result.results ?? [];
  }

  public async remove(repoId: string, userEmail: string): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare('DELETE FROM repo_collaborators WHERE repo_id = ? AND lower(user_email) = lower(?)')
          .bind(repoId, userEmail)
          .run(),
      'remove repo collaborator',
    );
  }

  public async deleteByRepo(repoId: string): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM repo_collaborators WHERE repo_id = ?').bind(repoId).run(),
      'delete collaborators by repo',
    );
  }
}

export { RepoCollaboratorDAO };
