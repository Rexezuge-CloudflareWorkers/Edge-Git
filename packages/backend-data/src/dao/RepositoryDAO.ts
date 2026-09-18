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
  owner_type?: string | null;
  owner_ci?: string | null;
  name_ci?: string | null;
  owner_user_email?: string | null;
  org_id?: string | null;
  forked_from_repo_id?: string | null;
  forked_from_full_name?: string | null;
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
    ownerType?: string;
    orgId?: string | null;
    ownerUserEmail?: string | null;
    forkedFromRepoId?: string | null;
    forkedFromFullName?: string | null;
  }): Promise<void> {
    const ownerType = input.ownerType ?? 'user';
    const ownerCi = input.owner.toLowerCase();
    const nameCi = input.name.toLowerCase();
    const ownerUserEmail = input.ownerUserEmail ?? (ownerType === 'user' ? input.ownerEmail : null);
    try {
      await this.withRetry(
        () =>
          this.database
            .prepare(
              'INSERT INTO repositories (id, owner_email, owner, name, description, is_private, created_at, updated_at, owner_type, owner_ci, name_ci, owner_user_email, org_id, forked_from_repo_id, forked_from_full_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              input.id,
              input.ownerEmail,
              input.owner,
              input.name,
              input.description,
              input.isPrivate ? 1 : 0,
              input.now,
              input.now,
              ownerType,
              ownerCi,
              nameCi,
              ownerUserEmail,
              input.orgId ?? null,
              input.forkedFromRepoId ?? null,
              input.forkedFromFullName ?? null,
            )
            .run(),
        'create repository',
      );
      return;
    } catch {
      // Fallback for DBs without 0004 fork columns: retry without them.
    }
    try {
      await this.withRetry(
        () =>
          this.database
            .prepare(
              'INSERT INTO repositories (id, owner_email, owner, name, description, is_private, created_at, updated_at, owner_type, owner_ci, name_ci, owner_user_email, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              input.id,
              input.ownerEmail,
              input.owner,
              input.name,
              input.description,
              input.isPrivate ? 1 : 0,
              input.now,
              input.now,
              ownerType,
              ownerCi,
              nameCi,
              ownerUserEmail,
              input.orgId ?? null,
            )
            .run(),
        'create repository',
      );
    } catch {
      // Fallback for DBs without 0002 columns (unit fakes / old D1): legacy insert.
      await this.withRetry(
        () =>
          this.database
            .prepare(
              'INSERT INTO repositories (id, owner_email, owner, name, description, is_private, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(input.id, input.ownerEmail, input.owner, input.name, input.description, input.isPrivate ? 1 : 0, input.now, input.now)
            .run(),
        'create repository legacy',
      );
    }
  }

  public async getByOwnerAndName(owner: string, name: string): Promise<RepositoryRow | null> {
    // Case-insensitive lookup covers 0002 rows (owner_ci/name_ci) and legacy
    // rows (owner/name with any case). Keeps `/:owner/:repo` stable across rename case.
    const ci = await this.database
      .prepare('SELECT * FROM repositories WHERE lower(owner) = ? AND lower(name) = ? LIMIT 1')
      .bind(owner.toLowerCase(), name.toLowerCase())
      .first<RepositoryRow>();
    if (ci) return ci;
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
      .prepare('SELECT * FROM repositories WHERE lower(owner) = ? ORDER BY updated_at DESC LIMIT ?')
      .bind(owner.toLowerCase(), limit)
      .all<RepositoryRow>();
    if ((result.results ?? []).length > 0) return result.results ?? [];
    const legacy = await this.database
      .prepare('SELECT * FROM repositories WHERE owner = ? ORDER BY updated_at DESC LIMIT ?')
      .bind(owner, limit)
      .all<RepositoryRow>();
    return legacy.results ?? [];
  }

  public async listByOwnerEmail(ownerEmail: string, limit = 100): Promise<RepositoryRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM repositories WHERE lower(owner_email) = lower(?) ORDER BY updated_at DESC LIMIT ?')
      .bind(ownerEmail, limit)
      .all<RepositoryRow>();
    return result.results ?? [];
  }

  public async listByOrgId(orgId: string, limit = 200): Promise<RepositoryRow[]> {
    try {
      const result = await this.database
        .prepare('SELECT * FROM repositories WHERE org_id = ? ORDER BY updated_at DESC LIMIT ?')
        .bind(orgId, limit)
        .all<RepositoryRow>();
      return result.results ?? [];
    } catch {
      return [];
    }
  }

  public async listByCollaboratorEmail(userEmail: string, limit = 500): Promise<RepositoryRow[]> {
    try {
      const result = await this.database
        .prepare(
          'SELECT r.* FROM repositories r JOIN repo_collaborators c ON c.repo_id = r.id WHERE lower(c.user_email) = lower(?) ORDER BY r.updated_at DESC LIMIT ?',
        )
        .bind(userEmail, limit)
        .all<RepositoryRow>();
      return result.results ?? [];
    } catch {
      return [];
    }
  }

  public async renameOwner(oldOwnerCi: string, newOwner: string, now?: number): Promise<void> {
    const newCi = newOwner.toLowerCase();
    const stamp = now ?? Math.floor(Date.now() / 1000);
    try {
      await this.withRetry(
        () =>
          this.database
            .prepare('UPDATE repositories SET owner = ?, owner_ci = ?, updated_at = ? WHERE lower(owner) = ?')
            .bind(newOwner, newCi, stamp, oldOwnerCi)
            .run(),
        'rename repo owner',
      );
      return;
    } catch {
      // Fall through to legacy variants below (missing columns on old D1).
    }
    try {
      await this.withRetry(
        () =>
          this.database
            .prepare('UPDATE repositories SET owner = ?, owner_ci = ? WHERE lower(owner) = ?')
            .bind(newOwner, newCi, oldOwnerCi)
            .run(),
        'rename repo owner',
      );
    } catch {
      await this.withRetry(
        () => this.database.prepare('UPDATE repositories SET owner = ? WHERE owner = ?').bind(newOwner, oldOwnerCi).run(),
        'rename repo owner legacy',
      );
    }
  }

  // Refresh denormalized fork-source names after the source owner renames.
  // Best-effort: silently skips DBs without the 0004 fork columns.
  public async updateForkSourceFullName(sourceRepoId: string, sourceFullName: string): Promise<void> {
    try {
      await this.withRetry(
        () =>
          this.database
            .prepare('UPDATE repositories SET forked_from_full_name = ? WHERE forked_from_repo_id = ?')
            .bind(sourceFullName, sourceRepoId)
            .run(),
        'rename fork source full name',
      );
    } catch {
      // Legacy DBs without fork columns — nothing to refresh.
    }
  }

  public async listForks(sourceRepoId: string, limit = 100): Promise<RepositoryRow[]> {
    try {
      const result = await this.database
        .prepare('SELECT * FROM repositories WHERE forked_from_repo_id = ? ORDER BY updated_at DESC LIMIT ?')
        .bind(sourceRepoId, limit)
        .all<RepositoryRow>();
      return result.results ?? [];
    } catch {
      // DBs without 0004 fork columns (unit fakes / old D1) have no forks.
      return [];
    }
  }

  public async countForks(sourceRepoId: string): Promise<number> {
    try {
      const row = await this.database
        .prepare('SELECT COUNT(*) AS n FROM repositories WHERE forked_from_repo_id = ?')
        .bind(sourceRepoId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    } catch {
      return 0;
    }
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
      () =>
        this.database
          .prepare(`UPDATE repositories SET ${sets.join(', ')} WHERE id = ?`)
          .bind(...values)
          .run(),
      'update repository',
    );
  }

  public async deleteById(id: string): Promise<void> {
    await this.withRetry(() => this.database.prepare('DELETE FROM repositories WHERE id = ?').bind(id).run(), 'delete repository');
  }

  // Backfill support: most-recently-updated repos first. Offset pagination is
  // fine here (cron iterates slowly, exact cursors unnecessary).
  public async listRecent(limit = 50, offset = 0): Promise<RepositoryRow[]> {
    try {
      const result = await this.database
        .prepare('SELECT * FROM repositories ORDER BY updated_at DESC LIMIT ? OFFSET ?')
        .bind(limit, offset)
        .all<RepositoryRow>();
      return result.results ?? [];
    } catch {
      return [];
    }
  }
}

export { RepositoryDAO };
