import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';
import type { IssueRow } from './IssueDAO';
import type { RepositoryRow } from './RepositoryDAO';

interface SearchOptions {
  limit?: number;
  repoId?: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isSafeInteger(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

function escapeLike(term: string): string {
  return term.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_');
}

/**
 * Metadata search over repositories + issues.
 *
 * Strategy: try FTS5 (`repo_fts` / `issue_fts` from migration 0005) first;
 * fall back to case-insensitive LIKE when the database (unit fakes, old D1)
 * lacks FTS5. Callers (SearchService) filter private rows via
 * PermissionService — this DAO intentionally returns candidates including
 * private repos so visibility stays in one place.
 */
class SearchDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async searchRepos(query: string, opts: SearchOptions = {}): Promise<RepositoryRow[]> {
    const limit = clampLimit(opts.limit);
    const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 10);
    if (tokens.length === 0) return [];
    const ftsQuery = tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(' AND ');
    try {
      const result = await this.database
        .prepare(
          `SELECT r.* FROM repo_fts f JOIN repositories r ON r.id = f.repo_id WHERE repo_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .bind(ftsQuery, limit)
        .all<RepositoryRow>();
      return result.results ?? [];
    } catch {
      // FTS5 unavailable — LIKE fallback over name/description/full name.
      const likes = tokens.map(() => `(lower(owner) LIKE ? ESCAPE '!' OR lower(name) LIKE ? ESCAPE '!' OR lower(COALESCE(description, '')) LIKE ? ESCAPE '!')`).join(' AND ');
      const params: unknown[] = [];
      for (const t of tokens) {
        const pattern = `%${escapeLike(t.toLowerCase())}%`;
        params.push(pattern, pattern, pattern);
      }
      params.push(limit);
      try {
        const result = await this.database
          .prepare(`SELECT * FROM repositories WHERE ${likes} ORDER BY updated_at DESC LIMIT ?`)
          .bind(...params)
          .all<RepositoryRow>();
        return result.results ?? [];
      } catch {
        return [];
      }
    }
  }

  public async searchIssues(query: string, opts: SearchOptions = {}): Promise<IssueRow[]> {
    const limit = clampLimit(opts.limit);
    const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 10);
    if (tokens.length === 0) return [];
    const ftsQuery = tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(' AND ');
    try {
      const base = opts.repoId
        ? `SELECT i.* FROM issue_fts f JOIN issues i ON i.id = f.issue_id WHERE issue_fts MATCH ? AND f.repo_id = ? ORDER BY rank LIMIT ?`
        : `SELECT i.* FROM issue_fts f JOIN issues i ON i.id = f.issue_id WHERE issue_fts MATCH ? ORDER BY rank LIMIT ?`;
      const result = await (opts.repoId
        ? this.database.prepare(base).bind(ftsQuery, opts.repoId, limit)
        : this.database.prepare(base).bind(ftsQuery, limit)
      ).all<IssueRow>();
      return result.results ?? [];
    } catch {
      const likes = tokens.map(() => `(lower(title) LIKE ? ESCAPE '!' OR lower(COALESCE(body, '')) LIKE ? ESCAPE '!')`).join(' AND ');
      const params: unknown[] = [];
      for (const t of tokens) {
        const pattern = `%${escapeLike(t.toLowerCase())}%`;
        params.push(pattern, pattern);
      }
      try {
        if (opts.repoId) {
          params.push(opts.repoId, limit);
          const result = await this.database
            .prepare(`SELECT * FROM issues WHERE repository_id = ? AND ${likes} ORDER BY number DESC LIMIT ?`)
            .bind(opts.repoId, ...params.slice(0, -2), limit)
            .all<IssueRow>();
          return result.results ?? [];
        }
        params.push(limit);
        const result = await this.database.prepare(`SELECT * FROM issues WHERE ${likes} ORDER BY updated_at DESC LIMIT ?`).bind(...params).all<IssueRow>();
        return result.results ?? [];
      } catch {
        return [];
      }
    }
  }
}

export { SearchDAO };
export type { SearchOptions };
