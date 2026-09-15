import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';

export interface RepositoryRow {
  id: string;
  owner_email: string;
  owner: string;
  name: string;
  description: string | null;
  is_private: number;
  created_at: number;
  updated_at: number;
}

class RepositoryDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async create(input: {
    id: string;
    ownerEmail: string;
    owner: string;
    name: string;
    description: string | null;
    isPrivate: boolean;
    now: number;
  }): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare(
            'INSERT INTO repositories (id, owner_email, owner, name, description, is_private, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(input.id, input.ownerEmail, input.owner, input.name, input.description, input.isPrivate ? 1 : 0, input.now, input.now)
          .run(),
      'create repository',
    );
  }

  public async getByOwnerAndName(owner: string, name: string): Promise<RepositoryRow | null> {
    return this.database
      .prepare('SELECT * FROM repositories WHERE owner = ? AND name = ? LIMIT 1')
      .bind(owner, name)
      .first<RepositoryRow>();
  }

  public async getById(id: string): Promise<RepositoryRow | null> {
    return this.findRowById<RepositoryRow>('repositories', 'id', id);
  }

  public async listByOwner(owner: string, limit = 100): Promise<RepositoryRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM repositories WHERE owner = ? ORDER BY updated_at DESC LIMIT ?')
      .bind(owner, limit)
      .all<RepositoryRow>();
    return result.results ?? [];
  }

  public async listByOwnerEmail(ownerEmail: string, limit = 100): Promise<RepositoryRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM repositories WHERE owner_email = ? ORDER BY updated_at DESC LIMIT ?')
      .bind(ownerEmail, limit)
      .all<RepositoryRow>();
    return result.results ?? [];
  }

  public async update(id: string, patch: { description?: string | null; isPrivate?: boolean; now: number }): Promise<void> {
    const sets: string[] = ['updated_at = ?'];
    const values: Array<string | number | null> = [patch.now];
    if (patch.description !== undefined) {
      sets.push('description = ?');
      values.push(patch.description);
    }
    if (patch.isPrivate !== undefined) {
      sets.push('is_private = ?');
      values.push(patch.isPrivate ? 1 : 0);
    }
    values.push(id);
    await this.withRetry(
      () => this.database.prepare(`UPDATE repositories SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run(),
      'update repository',
    );
  }

  public async deleteById(id: string): Promise<void> {
    await this.withRetry(() => this.database.prepare('DELETE FROM repositories WHERE id = ?').bind(id).run(), 'delete repository');
  }
}

export { RepositoryDAO };
