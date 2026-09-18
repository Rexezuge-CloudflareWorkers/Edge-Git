import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';
import type { IssueRow } from './IssueDAO';
import type { PullRequestRow } from './PullRequestDAO';
import type { RepositoryRow } from './RepositoryDAO';
import type { DiscussionRow } from './DiscussionDAO';
import type { SnippetRow } from './SnippetDAO';

interface SearchOptions {
  limit?: number;
  repoId?: string;
}

interface CodeHit {
  repo_id: string;
  path: string;
  oid: string | null;
  content: string;
  updated_at: number;
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
        .prepare(`SELECT r.* FROM repo_fts f JOIN repositories r ON r.id = f.repo_id WHERE repo_fts MATCH ? ORDER BY rank LIMIT ?`)
        .bind(ftsQuery, limit)
        .all<RepositoryRow>();
      return result.results ?? [];
    } catch {
      // FTS5 unavailable — LIKE fallback over name/description/full name.
      const likes = tokens
        .map(
          () => `(lower(owner) LIKE ? ESCAPE '!' OR lower(name) LIKE ? ESCAPE '!' OR lower(COALESCE(description, '')) LIKE ? ESCAPE '!')`,
        )
        .join(' AND ');
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
      const result = await (
        opts.repoId ? this.database.prepare(base).bind(ftsQuery, opts.repoId, limit) : this.database.prepare(base).bind(ftsQuery, limit)
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
        const result = await this.database
          .prepare(`SELECT * FROM issues WHERE ${likes} ORDER BY updated_at DESC LIMIT ?`)
          .bind(...params)
          .all<IssueRow>();
        return result.results ?? [];
      } catch {
        return [];
      }
    }
  }

  public async searchPulls(query: string, opts: SearchOptions = {}): Promise<PullRequestRow[]> {
    const limit = clampLimit(opts.limit);
    const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 10);
    if (tokens.length === 0) return [];
    const ftsQuery = tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(' AND ');
    try {
      const base = opts.repoId
        ? `SELECT p.* FROM pull_fts f JOIN pull_requests p ON p.id = f.pull_id WHERE pull_fts MATCH ? AND f.repo_id = ? ORDER BY rank LIMIT ?`
        : `SELECT p.* FROM pull_fts f JOIN pull_requests p ON p.id = f.pull_id WHERE pull_fts MATCH ? ORDER BY rank LIMIT ?`;
      const result = await (
        opts.repoId ? this.database.prepare(base).bind(ftsQuery, opts.repoId, limit) : this.database.prepare(base).bind(ftsQuery, limit)
      ).all<PullRequestRow>();
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
          const result = await this.database
            .prepare(`SELECT * FROM pull_requests WHERE repository_id = ? AND ${likes} ORDER BY number DESC LIMIT ?`)
            .bind(opts.repoId, ...params, limit)
            .all<PullRequestRow>();
          return result.results ?? [];
        }
        params.push(limit);
        const result = await this.database
          .prepare(`SELECT * FROM pull_requests WHERE ${likes} ORDER BY updated_at DESC LIMIT ?`)
          .bind(...params)
          .all<PullRequestRow>();
        return result.results ?? [];
      } catch {
        return [];
      }
    }
  }

  public async searchCode(query: string, opts: SearchOptions = {}): Promise<CodeHit[]> {
    const limit = clampLimit(opts.limit);
    const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 10);
    if (tokens.length === 0) return [];
    const ftsQuery = tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(' AND ');
    try {
      const base = opts.repoId
        ? `SELECT c.* FROM code_fts f JOIN code_index c ON c.repo_id = f.repo_id AND c.path = f.path WHERE code_fts MATCH ? AND f.repo_id = ? ORDER BY rank LIMIT ?`
        : `SELECT c.* FROM code_fts f JOIN code_index c ON c.repo_id = f.repo_id AND c.path = f.path WHERE code_fts MATCH ? ORDER BY rank LIMIT ?`;
      const result = await (
        opts.repoId ? this.database.prepare(base).bind(ftsQuery, opts.repoId, limit) : this.database.prepare(base).bind(ftsQuery, limit)
      ).all<CodeHit>();
      return result.results ?? [];
    } catch {
      const likes = tokens.map(() => `(lower(path) LIKE ? ESCAPE '!' OR lower(content) LIKE ? ESCAPE '!')`).join(' AND ');
      const params: unknown[] = [];
      for (const t of tokens) {
        const pattern = `%${escapeLike(t.toLowerCase())}%`;
        params.push(pattern, pattern);
      }
      try {
        if (opts.repoId) {
          const result = await this.database
            .prepare(`SELECT * FROM code_index WHERE repo_id = ? AND ${likes} ORDER BY path ASC LIMIT ?`)
            .bind(opts.repoId, ...params, limit)
            .all<CodeHit>();
          return result.results ?? [];
        }
        params.push(limit);
        const result = await this.database
          .prepare(`SELECT * FROM code_index WHERE ${likes} ORDER BY updated_at DESC LIMIT ?`)
          .bind(...params)
          .all<CodeHit>();
        return result.results ?? [];
      } catch {
        return [];
      }
    }
  }

  public async upsertCodeFile(input: { repoId: string; path: string; oid: string | null; content: string; now: number }): Promise<void> {
    try {
      await this.withRetry(
        () =>
          this.database
            .prepare(
              `INSERT INTO code_index (repo_id, path, oid, content, updated_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (repo_id, path) DO UPDATE SET oid = excluded.oid, content = excluded.content, updated_at = excluded.updated_at`,
            )
            .bind(input.repoId, input.path, input.oid, input.content, input.now)
            .run(),
        'upsert code index',
      );
    } catch {
      // Legacy DBs without migration 0006 — search degrades to no code results.
    }
  }

  public async deleteCodeFile(repoId: string, path: string): Promise<void> {
    try {
      await this.withRetry(
        () => this.database.prepare('DELETE FROM code_index WHERE repo_id = ? AND path = ?').bind(repoId, path).run(),
        'delete code index file',
      );
    } catch {
      // ignore — table may not exist on old DBs
    }
  }

  public async deleteCodeByRepo(repoId: string): Promise<void> {
    try {
      await this.withRetry(
        () => this.database.prepare('DELETE FROM code_index WHERE repo_id = ?').bind(repoId).run(),
        'delete code index by repo',
      );
    } catch {
      // ignore — table may not exist on old DBs
    }
  }

  public async searchDiscussions(query: string, opts: SearchOptions = {}): Promise<DiscussionRow[]> {
    const limit = clampLimit(opts.limit);
    const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 10);
    if (tokens.length === 0) return [];
    const ftsQuery = tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(' AND ');
    try {
      const base = opts.repoId
        ? `SELECT d.* FROM discussion_fts f JOIN discussions d ON d.id = f.discussion_id WHERE discussion_fts MATCH ? AND f.repo_id = ? ORDER BY rank LIMIT ?`
        : `SELECT d.* FROM discussion_fts f JOIN discussions d ON d.id = f.discussion_id WHERE discussion_fts MATCH ? ORDER BY rank LIMIT ?`;
      const result = await (
        opts.repoId ? this.database.prepare(base).bind(ftsQuery, opts.repoId, limit) : this.database.prepare(base).bind(ftsQuery, limit)
      ).all<DiscussionRow>();
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
          const result = await this.database
            .prepare(`SELECT * FROM discussions WHERE repository_id = ? AND ${likes} ORDER BY number DESC LIMIT ?`)
            .bind(opts.repoId, ...params, limit)
            .all<DiscussionRow>();
          return result.results ?? [];
        }
        params.push(limit);
        const result = await this.database
          .prepare(`SELECT * FROM discussions WHERE ${likes} ORDER BY updated_at DESC LIMIT ?`)
          .bind(...params)
          .all<DiscussionRow>();
        return result.results ?? [];
      } catch {
        return [];
      }
    }
  }

  public async searchSnippets(query: string, opts: { limit?: number } = {}): Promise<SnippetRow[]> {
    const limit = clampLimit(opts.limit);
    const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 10);
    if (tokens.length === 0) return [];
    const ftsQuery = tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(' AND ');
    try {
      const result = await this.database
        .prepare(
          `SELECT s.* FROM snippet_fts f JOIN snippets s ON s.id = f.snippet_id WHERE snippet_fts MATCH ? AND s.visibility = 'public' ORDER BY rank LIMIT ?`,
        )
        .bind(ftsQuery, limit)
        .all<SnippetRow>();
      return result.results ?? [];
    } catch {
      const likes = tokens.map(() => `lower(title) LIKE ? ESCAPE '!'`).join(' AND ');
      const params: unknown[] = tokens.map((t) => `%${escapeLike(t.toLowerCase())}%`);
      try {
        params.push(limit);
        const result = await this.database
          .prepare(`SELECT * FROM snippets WHERE visibility = 'public' AND ${likes} ORDER BY updated_at DESC LIMIT ?`)
          .bind(...params)
          .all<SnippetRow>();
        return result.results ?? [];
      } catch {
        return [];
      }
    }
  }
}

export { SearchDAO };
export type { CodeHit, SearchOptions };
