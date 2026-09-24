import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';
import { isMissingSchemaError } from '../utils/D1ErrorClassifier';
import { rowsOrEmpty, searchScopedWithTokens, throwUnlessMissingSchema } from './SearchFallback';
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
  buildLikeOrClause,
  likeParamsForTokens,
  prepareSearchQuery,
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
 * Strategy: try FTS5 (`repo_fts` / `issue_fts`) first; fall back to
 * case-insensitive LIKE when the database (unit fakes, D1 without FTS5)
 * lacks it. Callers (SearchService) filter private rows via
 * PermissionService — this DAO intentionally returns candidates including
 * private repos so visibility stays in one place.
 *
 * Token/FTS/LIKE construction lives in `SearchQueries` (pure builders);
 * methods here only run statements and degrade to `[]` when FTS is absent.
 */
class SearchDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  // Scoped FTS-first search lives in `./SearchFallback.ts` (Template Method);
  // domain methods below supply only SQL/params + LIKE specs.
  private scoped<T>(args: Parameters<typeof searchScopedWithTokens>[1]): Promise<T[]> {
    return searchScopedWithTokens<T>(this.database, args);
  }

  public async searchRepos(query: string, opts: SearchOptions = {}): Promise<RepositoryRow[]> {
    const prepared = prepareSearchQuery(query, opts.limit);
    if (!prepared) return [];
    const { limit, tokens, ftsQuery } = prepared;
    try {
      const result = await this.database
        .prepare(`SELECT r.* FROM repo_fts f JOIN repositories r ON r.id = f.repo_id WHERE repo_fts MATCH ? ORDER BY rank LIMIT ?`)
        .bind(ftsQuery, limit)
        .all<RepositoryRow>();
      return rowsOrEmpty(result);
    } catch {
      // FTS5 unavailable — LIKE fallback over name/description/full name.
      const likes = buildLikeOrClause(REPO_SEARCH_COLUMNS, tokens.length);
      const params: unknown[] = [...likeParamsForTokens(tokens, REPO_SEARCH_COLUMNS.length), limit];
      try {
        const result = await this.database
          .prepare(`SELECT * FROM repositories WHERE ${likes} ORDER BY updated_at DESC LIMIT ?`)
          .bind(...params)
          .all<RepositoryRow>();
        return rowsOrEmpty(result);
      } catch (error) {
        throwUnlessMissingSchema(error, 'repositories');
        return [];
      }
    }
  }

  public async searchIssues(query: string, opts: SearchOptions = {}): Promise<IssueRow[]> {
    const prepared = prepareSearchQuery(query, opts.limit);
    if (!prepared) return [];
    const { limit, tokens, ftsQuery } = prepared;
    const base = opts.repoId
      ? `SELECT i.* FROM issue_fts f JOIN issues i ON i.id = f.issue_id WHERE issue_fts MATCH ? AND f.repo_id = ? ORDER BY rank LIMIT ?`
      : `SELECT i.* FROM issue_fts f JOIN issues i ON i.id = f.issue_id WHERE issue_fts MATCH ? ORDER BY rank LIMIT ?`;
    return this.scoped<IssueRow>({
      resource: 'issues',
      ftsSql: base,
      ftsParams: opts.repoId ? [ftsQuery, opts.repoId, limit] : [ftsQuery, limit],
      likeSpec: {
        table: 'issues',
        scopeColumn: 'repository_id',
        scopeValue: opts.repoId,
        columns: TITLE_BODY_SEARCH_COLUMNS,
        scopedOrderBy: 'number DESC',
        unscopedOrderBy: 'updated_at DESC',
      },
      tokens,
      limit,
    });
  }

  public async searchPulls(query: string, opts: SearchOptions = {}): Promise<PullRequestRow[]> {
    const prepared = prepareSearchQuery(query, opts.limit);
    if (!prepared) return [];
    const { limit, tokens, ftsQuery } = prepared;
    const base = opts.repoId
      ? `SELECT p.* FROM pull_fts f JOIN pull_requests p ON p.id = f.pull_id WHERE pull_fts MATCH ? AND f.repo_id = ? ORDER BY rank LIMIT ?`
      : `SELECT p.* FROM pull_fts f JOIN pull_requests p ON p.id = f.pull_id WHERE pull_fts MATCH ? ORDER BY rank LIMIT ?`;
    return this.scoped<PullRequestRow>({
      resource: 'pulls',
      ftsSql: base,
      ftsParams: opts.repoId ? [ftsQuery, opts.repoId, limit] : [ftsQuery, limit],
      likeSpec: {
        table: 'pull_requests',
        scopeColumn: 'repository_id',
        scopeValue: opts.repoId,
        columns: TITLE_BODY_SEARCH_COLUMNS,
        scopedOrderBy: 'number DESC',
        unscopedOrderBy: 'updated_at DESC',
      },
      tokens,
      limit,
    });
  }

  public async searchCode(query: string, opts: SearchOptions = {}): Promise<CodeHit[]> {
    const prepared = prepareSearchQuery(query, opts.limit);
    if (!prepared) return [];
    const { limit, tokens, ftsQuery } = prepared;
    const base = opts.repoId
      ? `SELECT c.* FROM code_fts f JOIN code_index c ON c.repo_id = f.repo_id AND c.path = f.path WHERE code_fts MATCH ? AND f.repo_id = ? ORDER BY rank LIMIT ?`
      : `SELECT c.* FROM code_fts f JOIN code_index c ON c.repo_id = f.repo_id AND c.path = f.path WHERE code_fts MATCH ? ORDER BY rank LIMIT ?`;
    return this.scoped<CodeHit>({
      resource: 'code',
      ftsSql: base,
      ftsParams: opts.repoId ? [ftsQuery, opts.repoId, limit] : [ftsQuery, limit],
      likeSpec: {
        table: 'code_index',
        scopeColumn: 'repo_id',
        scopeValue: opts.repoId,
        columns: CODE_SEARCH_COLUMNS,
        scopedOrderBy: 'path ASC',
        unscopedOrderBy: 'updated_at DESC',
      },
      tokens,
      limit,
    });
  }

  public async upsertCodeFile(input: CodeFileInput): Promise<number> {
    try {
      const result = await this.withRetry(
        () => this.database.prepare(UPSERT_CODE_FILE_SQL).bind(input.repoId, input.path, input.oid, input.content, input.now).run(),
        'upsert code index',
      );
      return result.meta?.changes ?? 0;
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
      // Fakes/DBs without code search tables — search degrades to no code results.
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
        } catch (error) {
          if (!isMissingSchemaError(error)) throw error;
          // Fall through to sequential upserts below.
        }
      }
      let changed = 0;
      for (const input of inputs) {
        changed += await this.upsertCodeFile(input);
      }
      return changed;
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
      // Fakes/DBs without code search tables — search degrades to no code results.
      return 0;
    }
  }

  // Dirty-check support for the backfill cron: fetch indexed (path, oid)
  // pairs once per repo so unchanged HEAD files skip their blob fetch and
  // upsert entirely. Single indexed read vs ~250 rows-read per rewrite.
  public async getOidsByRepo(repoId: string): Promise<CodeOidEntry[]> {
    try {
      const result = await this.database.prepare('SELECT path, oid FROM code_index WHERE repo_id = ?').bind(repoId).all<CodeOidEntry>();
      return rowsOrEmpty(result);
    } catch (error) {
      throwUnlessMissingSchema(error, 'indexed oids');
      // Fakes/DBs without code search tables.
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
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
      return 0;
    }
  }

  public async deleteCodeFile(repoId: string, path: string): Promise<void> {
    try {
      await this.withRetry(
        () => this.database.prepare('DELETE FROM code_index WHERE repo_id = ? AND path = ?').bind(repoId, path).run(),
        'delete code index file',
      );
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
      // ignore — table may not exist on old DBs
    }
  }

  public async deleteCodeByRepo(repoId: string): Promise<void> {
    try {
      await this.withRetry(
        () => this.database.prepare('DELETE FROM code_index WHERE repo_id = ?').bind(repoId).run(),
        'delete code index by repo',
      );
    } catch (error) {
      if (!isMissingSchemaError(error)) throw error;
      // ignore — table may not exist on old DBs
    }
  }

  // Repo-delete alias: FTS rows for issues/pulls/discussions/repos are
  // trigger-maintained off their base-table deletes, so only the code index
  // (keyed by repo with no base row) needs an explicit purge here.
  public async deleteByRepo(repoId: string): Promise<void> {
    await this.deleteCodeByRepo(repoId);
  }

  public async searchDiscussions(query: string, opts: SearchOptions = {}): Promise<DiscussionRow[]> {
    const prepared = prepareSearchQuery(query, opts.limit);
    if (!prepared) return [];
    const { limit, tokens, ftsQuery } = prepared;
    const base = opts.repoId
      ? `SELECT d.* FROM discussion_fts f JOIN discussions d ON d.id = f.discussion_id WHERE discussion_fts MATCH ? AND f.repo_id = ? ORDER BY rank LIMIT ?`
      : `SELECT d.* FROM discussion_fts f JOIN discussions d ON d.id = f.discussion_id WHERE discussion_fts MATCH ? ORDER BY rank LIMIT ?`;
    return this.scoped<DiscussionRow>({
      resource: 'discussions',
      ftsSql: base,
      ftsParams: opts.repoId ? [ftsQuery, opts.repoId, limit] : [ftsQuery, limit],
      likeSpec: {
        table: 'discussions',
        scopeColumn: 'repository_id',
        scopeValue: opts.repoId,
        columns: TITLE_BODY_SEARCH_COLUMNS,
        scopedOrderBy: 'number DESC',
        unscopedOrderBy: 'updated_at DESC',
      },
      tokens,
      limit,
    });
  }

  public async searchSnippets(query: string, opts: { limit?: number } = {}): Promise<SnippetRow[]> {
    const prepared = prepareSearchQuery(query, opts.limit);
    if (!prepared) return [];
    const { limit, tokens, ftsQuery } = prepared;
    try {
      const result = await this.database
        .prepare(
          `SELECT s.* FROM snippet_fts f JOIN snippets s ON s.id = f.snippet_id WHERE snippet_fts MATCH ? AND s.visibility = 'public' ORDER BY rank LIMIT ?`,
        )
        .bind(ftsQuery, limit)
        .all<SnippetRow>();
      return rowsOrEmpty(result);
    } catch {
      const likes = buildLikeOrClause(SNIPPET_SEARCH_COLUMNS, tokens.length);
      const params: unknown[] = likeParamsForTokens(tokens, SNIPPET_SEARCH_COLUMNS.length);
      try {
        params.push(limit);
        const result = await this.database
          .prepare(`SELECT * FROM snippets WHERE visibility = 'public' AND ${likes} ORDER BY updated_at DESC LIMIT ?`)
          .bind(...params)
          .all<SnippetRow>();
        return rowsOrEmpty(result);
      } catch (error) {
        throwUnlessMissingSchema(error, 'snippets');
        return [];
      }
    }
  }
}

export { SearchDAO };
export type { CodeFileInput, CodeHit, CodeOidEntry, SearchOptions };
