import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';
import type { IssueRow } from './IssueDAO';
import type { PullRequestRow } from './PullRequestDAO';
import type { RepositoryRow } from './RepositoryDAO';
import type { DiscussionRow } from './DiscussionDAO';
import type { SnippetRow } from './SnippetDAO';
import {
  CODE_SEARCH_COLUMNS,
  REPO_SEARCH_COLUMNS,
  SNIPPET_SEARCH_COLUMNS,
  TITLE_BODY_SEARCH_COLUMNS,
  UPSERT_CODE_FILE_SQL,
  buildFtsQuery,
  buildLikeOrClause,
  clampSearchLimit,
  likeParamsForTokens,
  tokenizeSearchQuery,
} from './SearchQueries';

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

interface CodeOidEntry {
  path: string;
  oid: string | null;
}

interface CodeFileInput {
  repoId: string;
  path: string;
  oid: string | null;
  content: string;
  now: number;
}

/**
 * Metadata search over repositories + issues.
 *
 * Strategy: try FTS5 (`repo_fts` / `issue_fts` from migration 0005) first;
 * fall back to case-insensitive LIKE when the database (unit fakes, old D1)
 * lacks FTS5. Callers (SearchService) filter private rows via
 * PermissionService — this DAO intentionally returns candidates including
 * private repos so visibility stays in one place.
 *
 * Token/FTS/LIKE construction lives in `SearchQueries` (pure builders);
 * methods here only run statements and degrade to `[]` on legacy DBs.
 */
class SearchDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async searchRepos(query: string, opts: SearchOptions = {}): Promise<RepositoryRow[]> {
    const limit = clampSearchLimit(opts.limit);
    const tokens = tokenizeSearchQuery(query);
    if (tokens.length === 0) return [];
    const ftsQuery = buildFtsQuery(tokens);
    try {
      const result = await this.database
        .prepare(`SELECT r.* FROM repo_fts f JOIN repositories r ON r.id = f.repo_id WHERE repo_fts MATCH ? ORDER BY rank LIMIT ?`)
        .bind(ftsQuery, limit)
        .all<RepositoryRow>();
      return result.results ?? [];
    } catch {
      // FTS5 unavailable — LIKE fallback over name/description/full name.
      const likes = buildLikeOrClause(REPO_SEARCH_COLUMNS, tokens.length);
      const params: unknown[] = [...likeParamsForTokens(tokens, REPO_SEARCH_COLUMNS.length), limit];
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
    const limit = clampSearchLimit(opts.limit);
    const tokens = tokenizeSearchQuery(query);
    if (tokens.length === 0) return [];
    const ftsQuery = buildFtsQuery(tokens);
    try {
      const base = opts.repoId
        ? `SELECT i.* FROM issue_fts f JOIN issues i ON i.id = f.issue_id WHERE issue_fts MATCH ? AND f.repo_id = ? ORDER BY rank LIMIT ?`
        : `SELECT i.* FROM issue_fts f JOIN issues i ON i.id = f.issue_id WHERE issue_fts MATCH ? ORDER BY rank LIMIT ?`;
      const result = await (
        opts.repoId ? this.database.prepare(base).bind(ftsQuery, opts.repoId, limit) : this.database.prepare(base).bind(ftsQuery, limit)
      ).all<IssueRow>();
      return result.results ?? [];
    } catch {
      const likes = buildLikeOrClause(TITLE_BODY_SEARCH_COLUMNS, tokens.length);
      const params: unknown[] = likeParamsForTokens(tokens, TITLE_BODY_SEARCH_COLUMNS.length);
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
    const limit = clampSearchLimit(opts.limit);
    const tokens = tokenizeSearchQuery(query);
    if (tokens.length === 0) return [];
    const ftsQuery = buildFtsQuery(tokens);
    try {
      const base = opts.repoId
        ? `SELECT p.* FROM pull_fts f JOIN pull_requests p ON p.id = f.pull_id WHERE pull_fts MATCH ? AND f.repo_id = ? ORDER BY rank LIMIT ?`
        : `SELECT p.* FROM pull_fts f JOIN pull_requests p ON p.id = f.pull_id WHERE pull_fts MATCH ? ORDER BY rank LIMIT ?`;
      const result = await (
        opts.repoId ? this.database.prepare(base).bind(ftsQuery, opts.repoId, limit) : this.database.prepare(base).bind(ftsQuery, limit)
      ).all<PullRequestRow>();
      return result.results ?? [];
    } catch {
      const likes = buildLikeOrClause(TITLE_BODY_SEARCH_COLUMNS, tokens.length);
      const params: unknown[] = likeParamsForTokens(tokens, TITLE_BODY_SEARCH_COLUMNS.length);
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
    const limit = clampSearchLimit(opts.limit);
    const tokens = tokenizeSearchQuery(query);
    if (tokens.length === 0) return [];
    const ftsQuery = buildFtsQuery(tokens);
    try {
      const base = opts.repoId
        ? `SELECT c.* FROM code_fts f JOIN code_index c ON c.repo_id = f.repo_id AND c.path = f.path WHERE code_fts MATCH ? AND f.repo_id = ? ORDER BY rank LIMIT ?`
        : `SELECT c.* FROM code_fts f JOIN code_index c ON c.repo_id = f.repo_id AND c.path = f.path WHERE code_fts MATCH ? ORDER BY rank LIMIT ?`;
      const result = await (
        opts.repoId ? this.database.prepare(base).bind(ftsQuery, opts.repoId, limit) : this.database.prepare(base).bind(ftsQuery, limit)
      ).all<CodeHit>();
      return result.results ?? [];
    } catch {
      const likes = buildLikeOrClause(CODE_SEARCH_COLUMNS, tokens.length);
      const params: unknown[] = likeParamsForTokens(tokens, CODE_SEARCH_COLUMNS.length);
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

  public async upsertCodeFile(input: { repoId: string; path: string; oid: string | null; content: string; now: number }): Promise<number> {
    try {
      const result = await this.withRetry(
        () => this.database.prepare(UPSERT_CODE_FILE_SQL).bind(input.repoId, input.path, input.oid, input.content, input.now).run(),
        'upsert code index',
      );
      return result.meta?.changes ?? 0;
    } catch {
      // Legacy DBs without migration 0006 — search degrades to no code results.
      return 0;
    }
  }

  // Batched variant for the backfill cron: one D1 batch per repo instead of
  // one roundtrip per file. Falls back to sequential upserts on fakes and
  // legacy bindings without `batch` (and on batch failure, where per-row
  // retry still applies). Returns the number of rows changed.
  public async upsertCodeFiles(inputs: CodeFileInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    try {
      const database = this.database;
      if (typeof database.batch === 'function') {
        try {
          const statements = inputs.map((input) =>
            database.prepare(UPSERT_CODE_FILE_SQL).bind(input.repoId, input.path, input.oid, input.content, input.now),
          );
          const results = await database.batch(statements);
          return results.reduce((total, result) => total + ((result.meta?.changes ?? 0) || 0), 0);
        } catch {
          // Fall through to sequential upserts below.
        }
      }
      let changed = 0;
      for (const input of inputs) {
        changed += await this.upsertCodeFile(input);
      }
      return changed;
    } catch {
      // Legacy DBs without migration 0006 — search degrades to no code results.
      return 0;
    }
  }

  // Dirty-check support for the backfill cron: fetch indexed (path, oid)
  // pairs once per repo so unchanged HEAD files skip their blob fetch and
  // upsert entirely. Single indexed read vs ~250 rows-read per rewrite.
  public async getOidsByRepo(repoId: string): Promise<CodeOidEntry[]> {
    try {
      const result = await this.database
        .prepare('SELECT path, oid FROM code_index WHERE repo_id = ?')
        .bind(repoId)
        .all<CodeOidEntry>();
      return result.results ?? [];
    } catch {
      // Legacy DBs without migration 0006.
      return [];
    }
  }

  // Delete index rows for paths no longer present at HEAD (push deletions
  // never pass through the web delete path). Only call after a successful
  // HEAD listing — never on listing failure, or a DO outage would wipe the
  // index. Returns the number of rows removed.
  public async deleteCodePathsNotIn(repoId: string, keepPaths: string[]): Promise<number> {
    try {
      if (keepPaths.length === 0) {
        const result = await this.withRetry(
          () => this.database.prepare('DELETE FROM code_index WHERE repo_id = ?').bind(repoId).run(),
          'delete stale code index',
        );
        return result.meta?.changes ?? 0;
      }
      const placeholders = keepPaths.map(() => '?').join(', ');
      const result = await this.withRetry(
        () =>
          this.database
            .prepare(`DELETE FROM code_index WHERE repo_id = ? AND path NOT IN (${placeholders})`)
            .bind(repoId, ...keepPaths)
            .run(),
        'delete stale code index',
      );
      return result.meta?.changes ?? 0;
    } catch {
      return 0;
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
    const limit = clampSearchLimit(opts.limit);
    const tokens = tokenizeSearchQuery(query);
    if (tokens.length === 0) return [];
    const ftsQuery = buildFtsQuery(tokens);
    try {
      const base = opts.repoId
        ? `SELECT d.* FROM discussion_fts f JOIN discussions d ON d.id = f.discussion_id WHERE discussion_fts MATCH ? AND f.repo_id = ? ORDER BY rank LIMIT ?`
        : `SELECT d.* FROM discussion_fts f JOIN discussions d ON d.id = f.discussion_id WHERE discussion_fts MATCH ? ORDER BY rank LIMIT ?`;
      const result = await (
        opts.repoId ? this.database.prepare(base).bind(ftsQuery, opts.repoId, limit) : this.database.prepare(base).bind(ftsQuery, limit)
      ).all<DiscussionRow>();
      return result.results ?? [];
    } catch {
      const likes = buildLikeOrClause(TITLE_BODY_SEARCH_COLUMNS, tokens.length);
      const params: unknown[] = likeParamsForTokens(tokens, TITLE_BODY_SEARCH_COLUMNS.length);
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
    const limit = clampSearchLimit(opts.limit);
    const tokens = tokenizeSearchQuery(query);
    if (tokens.length === 0) return [];
    const ftsQuery = buildFtsQuery(tokens);
    try {
      const result = await this.database
        .prepare(
          `SELECT s.* FROM snippet_fts f JOIN snippets s ON s.id = f.snippet_id WHERE snippet_fts MATCH ? AND s.visibility = 'public' ORDER BY rank LIMIT ?`,
        )
        .bind(ftsQuery, limit)
        .all<SnippetRow>();
      return result.results ?? [];
    } catch {
      const likes = buildLikeOrClause(SNIPPET_SEARCH_COLUMNS, tokens.length);
      const params: unknown[] = likeParamsForTokens(tokens, SNIPPET_SEARCH_COLUMNS.length);
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
export type { CodeFileInput, CodeHit, CodeOidEntry, SearchOptions };
