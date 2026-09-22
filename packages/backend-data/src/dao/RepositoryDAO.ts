import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';
import { isMissingSchemaError } from '../utils/D1ErrorClassifier';
import { DatabaseError } from '@edge-git/backend-errors';
import { buildSetClause } from './UpdateClause';

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
    } catch (error) {
      // Fail closed: only fall back for DBs without 0004 fork columns.
      // Genuine failures (constraint, D1 outage) must propagate, never retry
      // silently on a narrower schema and mask the real error + double cost.
      if (!isMissingSchemaError(error)) throw error;
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
    } catch (error) {
      // Fail closed: only legacy DBs without 0002 columns fall through.
      if (!isMissingSchemaError(error)) throw error;
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
    // Indexed case-insensitive lookup first: `owner_ci/name_ci` are indexed
    // (migration 0002). `lower(owner)` cannot use those indexes (full scan),
    // so it is only a fallback for legacy rows lacking the ci columns.
    // Non-schema failures wrap as DatabaseError (never raw): git auth maps
    // DatabaseError → 503 (outage, retryable) vs 401 (bad credentials), so a
    // raw D1 error must not leak through as a confusing 500.
    const ownerCi = owner.toLowerCase();
    const nameCi = name.toLowerCase();
    try {
      const indexed = await this.database
        .prepare('SELECT * FROM repositories WHERE owner_ci = ? AND name_ci = ? LIMIT 1')
        .bind(ownerCi, nameCi)
        .first<RepositoryRow>();
      if (indexed) return indexed;
    } catch (error) {
      if (!isMissingSchemaError(error))
        throw new DatabaseError(`Failed to look up repository: ${error instanceof Error ? error.message : String(error)}`);
    }
    let ci: RepositoryRow | null = null;
    try {
      ci = await this.database
        .prepare('SELECT * FROM repositories WHERE lower(owner) = ? AND lower(name) = ? LIMIT 1')
        .bind(ownerCi, nameCi)
        .first<RepositoryRow>();
    } catch (error) {
      if (!isMissingSchemaError(error))
        throw new DatabaseError(`Failed to look up repository: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (ci) return ci;
    try {
      return await this.database
        .prepare('SELECT * FROM repositories WHERE owner = ? AND name = ? LIMIT 1')
        .bind(owner, name)
        .first<RepositoryRow>();
    } catch (error) {
      throw new DatabaseError(`Failed to look up repository: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async getById(id: string): Promise<RepositoryRow | null> {
    return this.findRowById<RepositoryRow>('repositories', 'id', id);
  }

  public async listByOwner(owner: string, limit = 100): Promise<RepositoryRow[]> {
    const ownerCi = owner.toLowerCase();
    try {
      const result = await this.database
        .prepare('SELECT * FROM repositories WHERE owner_ci = ? ORDER BY updated_at DESC LIMIT ?')
        .bind(ownerCi, limit)
        .all<RepositoryRow>();
      if ((result.results ?? []).length > 0) return result.results ?? [];
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
    }
    const result = await this.database
      .prepare('SELECT * FROM repositories WHERE lower(owner) = ? ORDER BY updated_at DESC LIMIT ?')
      .bind(ownerCi, limit)
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
    } catch (error) {
      // Fail closed: only legacy DBs without org columns degrade to [].
      if (!isMissingSchemaError(error))
        throw new DatabaseError(`Failed to list repositories by org: ${error instanceof Error ? error.message : String(error)}`);
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
    } catch (error) {
      if (!isMissingSchemaError(error))
        throw new DatabaseError(`Failed to list collaborator repositories: ${error instanceof Error ? error.message : String(error)}`);
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
            .prepare('UPDATE repositories SET owner = ?, owner_ci = ?, updated_at = ? WHERE owner_ci = ?')
            .bind(newOwner, newCi, stamp, oldOwnerCi.toLowerCase())
            .run(),
        'rename repo owner',
      );
      return;
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
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
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
      await this.withRetry(
        () => this.database.prepare('UPDATE repositories SET owner = ? WHERE owner = ?').bind(newOwner, oldOwnerCi).run(),
        'rename repo owner legacy',
      );
    }
  }

  // Refresh denormalized fork-source names after the source owner renames.
  // Best-effort only for legacy DBs without fork columns; genuine failures propagate.
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
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
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
    } catch (error) {
      if (!isMissingSchemaError(error))
        throw new DatabaseError(`Failed to list forks: ${error instanceof Error ? error.message : String(error)}`);
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
    } catch (error) {
      if (!isMissingSchemaError(error))
        throw new DatabaseError(`Failed to count forks: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  public async update(id: string, patch: { description?: string | null; isPrivate?: boolean; now: number }): Promise<void> {
    const assignments: Array<{ column: string; value: unknown }> = [{ column: 'updated_at', value: patch.now }];
    if (patch.description !== undefined) assignments.push({ column: 'description', value: patch.description });
    if (patch.isPrivate !== undefined) assignments.push({ column: 'is_private', value: patch.isPrivate ? 1 : 0 });
    const { clause, values } = buildSetClause(assignments);
    await this.withRetry(
      () =>
        this.database
          .prepare(`UPDATE repositories SET ${clause} WHERE id = ?`)
          .bind(...values, id)
          .run(),
      'update repository',
    );
  }

  public async deleteById(id: string): Promise<void> {
    await this.withRetry(() => this.database.prepare('DELETE FROM repositories WHERE id = ?').bind(id).run(), 'delete repository');
  }

  // Backfill support: most-recently-updated repos first. Offset pagination is
  // fine here (cron iterates slowly, exact cursors unnecessary).
  // Fail closed: only legacy-schema errors degrade to [].
  public async listRecent(limit = 50, offset = 0): Promise<RepositoryRow[]> {
    try {
      const result = await this.database
        .prepare('SELECT * FROM repositories ORDER BY updated_at DESC LIMIT ? OFFSET ?')
        .bind(limit, offset)
        .all<RepositoryRow>();
      return result.results ?? [];
    } catch (error) {
      if (!isMissingSchemaError(error))
        throw new DatabaseError(`Failed to list recent repositories: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
}

export { RepositoryDAO };
