import { IssueDAO, RepositoryDAO, SearchDAO } from '@edge-git/backend-data/dao';
import type { CodeHit, DiscussionRow, IssueRow, PullRequestRow, RepositoryRow, SnippetRow } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError } from '@edge-git/backend-errors';
import { EmailAddress, TimestampUtil } from '@edge-git/shared/utils';
import { PermissionService } from '../permission/PermissionService';

interface SearchServiceEnv {
  DB: D1Queryable;
}

interface SearchServiceDeps {
  searchDAO?: () => Promise<SearchDAO>;
  repositoryDAO?: () => Promise<RepositoryDAO>;
  issueDAO?: () => Promise<IssueDAO>;
  permissionService?: () => Promise<PermissionService>;
}

const MAX_QUERY_LENGTH = 200;
const MAX_LIMIT = 50;
const MAX_INDEX_BYTES = 20_000;

type SearchType = 'repos' | 'issues' | 'pulls' | 'code' | 'discussions' | 'snippets';

class SearchService {
  private readonly deps: Required<SearchServiceDeps>;

  constructor(
    private readonly env: SearchServiceEnv,
    deps: SearchServiceDeps = {},
  ) {
    this.deps = {
      searchDAO: () => Promise.resolve(new SearchDAO(env.DB)),
      repositoryDAO: () => Promise.resolve(new RepositoryDAO(env.DB)),
      issueDAO: () => Promise.resolve(new IssueDAO(env.DB)),
      permissionService: () => Promise.resolve(new PermissionService(env)),
      ...deps,
    };
  }

  public static sanitizeQuery(raw: string): string {
    const trimmed = raw.trim().replaceAll(/\s+/g, ' ');
    if (trimmed.length < 2) throw new BadRequestError('q must be at least 2 characters');
    if (trimmed.length > MAX_QUERY_LENGTH) throw new BadRequestError(`q must be at most ${MAX_QUERY_LENGTH} characters`);
    return trimmed.slice(0, MAX_QUERY_LENGTH);
  }

  public static clampLimit(raw: unknown): number {
    const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
    if (!Number.isSafeInteger(n)) return 20;
    return Math.min(Math.max(n, 1), MAX_LIMIT);
  }

  public static parseType(raw: unknown): SearchType {
    if (raw === 'issues') return 'issues';
    if (raw === 'pulls') return 'pulls';
    if (raw === 'code') return 'code';
    if (raw === 'discussions') return 'discussions';
    if (raw === 'snippets') return 'snippets';
    return 'repos';
  }

  public static isIndexablePath(path: string): boolean {
    const p = path.trim();
    if (!p || p.length > 512) return false;
    if (p.includes('..') || p.startsWith('/') || p.includes(String.fromCodePoint(0))) return false;
    // Skip vendored/minified/lock artifacts to keep the index small.
    if (p.startsWith('node_modules/') || p.includes('/node_modules/')) return false;
    if (p === 'pnpm-lock.yaml' || p === 'package-lock.json' || p.endsWith('.min.js') || p.endsWith('.map')) return false;
    return true;
  }

  public static truncateForIndex(content: string): string {
    return content.length > MAX_INDEX_BYTES ? content.slice(0, MAX_INDEX_BYTES) : content;
  }

  private permissionServiceSync(): PermissionService {
    // Fast path for visibility checks when deps use default construction.
    // Injected `permissionService` thunk is preferred; this fallback only
    // exists for legacy direct `new SearchService(env)` call sites.
    return new PermissionService(this.env);
  }

  private static normalizeViewer(viewerEmail: string | null): string | null {
    if (!viewerEmail) return null;
    try {
      return EmailAddress.normalize(viewerEmail);
    } catch {
      return viewerEmail;
    }
  }

  public async searchRepos(query: string, viewerEmail: string | null, limit = 20): Promise<RepositoryRow[]> {
    const q = SearchService.sanitizeQuery(query);
    const viewer = SearchService.normalizeViewer(viewerEmail);
    const dao = await this.deps.searchDAO();
    // Over-fetch candidates, then filter private rows via PermissionService.
    const candidates = await dao.searchRepos(q, { limit: Math.min(limit * 3, MAX_LIMIT) });
    const permission = await this.deps.permissionService().catch(() => this.permissionServiceSync());
    const visible: RepositoryRow[] = [];
    for (const row of candidates) {
      const role = await permission.getRole(viewer, row).catch(() => null);
      if (role) visible.push(row);
      if (visible.length >= limit) break;
    }
    return visible;
  }

  public async searchIssues(
    query: string,
    viewerEmail: string | null,
    opts: { limit?: number; repoId?: string } = {},
  ): Promise<IssueRow[]> {
    const q = SearchService.sanitizeQuery(query);
    const viewer = SearchService.normalizeViewer(viewerEmail);
    const limit = SearchService.clampLimit(opts.limit ?? 20);
    const dao = await this.deps.searchDAO();
    const candidates = await dao.searchIssues(q, { limit: Math.min(limit * 3, MAX_LIMIT), repoId: opts.repoId });
    const permission = await this.deps.permissionService().catch(() => this.permissionServiceSync());
    const repositoryDAO = await this.deps.repositoryDAO().catch(() => null);
    const repoCache = new Map<string, RepositoryRow | null>();
    const visible: IssueRow[] = [];
    for (const issue of candidates) {
      let repo: RepositoryRow | null | undefined = repoCache.get(issue.repository_id);
      if (repo === undefined) {
        repo = repositoryDAO ? await repositoryDAO.getById(issue.repository_id).catch(() => null) : null;
        repoCache.set(issue.repository_id, repo ?? null);
      }
      if (!repo) continue;
      const role = await permission.getRole(viewer, repo).catch(() => null);
      if (role) visible.push(issue);
      if (visible.length >= limit) break;
    }
    return visible;
  }

  public async searchPulls(
    query: string,
    viewerEmail: string | null,
    opts: { limit?: number; repoId?: string } = {},
  ): Promise<PullRequestRow[]> {
    const q = SearchService.sanitizeQuery(query);
    const viewer = SearchService.normalizeViewer(viewerEmail);
    const limit = SearchService.clampLimit(opts.limit ?? 20);
    const dao = await this.deps.searchDAO();
    const candidates = await dao.searchPulls(q, { limit: Math.min(limit * 3, MAX_LIMIT), repoId: opts.repoId });
    const permission = await this.deps.permissionService().catch(() => this.permissionServiceSync());
    const repositoryDAO = await this.deps.repositoryDAO().catch(() => null);
    const repoCache = new Map<string, RepositoryRow | null>();
    const visible: PullRequestRow[] = [];
    for (const pull of candidates) {
      let repo: RepositoryRow | null | undefined = repoCache.get(pull.repository_id);
      if (repo === undefined) {
        repo = repositoryDAO ? await repositoryDAO.getById(pull.repository_id).catch(() => null) : null;
        repoCache.set(pull.repository_id, repo ?? null);
      }
      if (!repo) continue;
      const role = await permission.getRole(viewer, repo).catch(() => null);
      if (role) visible.push(pull);
      if (visible.length >= limit) break;
    }
    return visible;
  }

  public async searchCode(
    query: string,
    viewerEmail: string | null,
    opts: { limit?: number; repoId?: string } = {},
  ): Promise<Array<CodeHit & { snippet: string }>> {
    const q = SearchService.sanitizeQuery(query);
    const viewer = SearchService.normalizeViewer(viewerEmail);
    const limit = SearchService.clampLimit(opts.limit ?? 20);
    const dao = await this.deps.searchDAO();
    const candidates = await dao.searchCode(q, { limit: Math.min(limit * 3, MAX_LIMIT), repoId: opts.repoId });
    const permission = await this.deps.permissionService().catch(() => this.permissionServiceSync());
    const repositoryDAO = await this.deps.repositoryDAO().catch(() => null);
    const repoCache = new Map<string, RepositoryRow | null>();
    const firstToken = q.split(' ', 1)[0].toLowerCase();
    const visible: Array<CodeHit & { snippet: string }> = [];
    for (const hit of candidates) {
      let repo: RepositoryRow | null | undefined = repoCache.get(hit.repo_id);
      if (repo === undefined) {
        repo = repositoryDAO ? await repositoryDAO.getById(hit.repo_id).catch(() => null) : null;
        repoCache.set(hit.repo_id, repo ?? null);
      }
      if (!repo) continue;
      const role = await permission.getRole(viewer, repo).catch(() => null);
      if (!role) continue;
      visible.push({ ...hit, snippet: SearchService.buildSnippet(hit.content, firstToken) });
      if (visible.length >= limit) break;
    }
    return visible;
  }

  private static buildSnippet(content: string, token: string): string {
    const idx = content.toLowerCase().indexOf(token);
    if (idx === -1) return content.slice(0, 200);
    const start = Math.max(0, idx - 80);
    return content.slice(start, start + 200);
  }

  public async indexFile(input: { repoId: string; path: string; oid: string | null; content: string }): Promise<boolean> {
    if (!SearchService.isIndexablePath(input.path)) return false;
    if (input.content.includes(String.fromCodePoint(0))) return false;
    const dao = await this.deps.searchDAO();
    await dao.upsertCodeFile({
      repoId: input.repoId,
      path: input.path,
      oid: input.oid,
      content: SearchService.truncateForIndex(input.content),
      now: TimestampUtil.getCurrentUnixTimestampInSeconds(),
    });
    return true;
  }

  public async removeFile(repoId: string, path: string): Promise<void> {
    const dao = await this.deps.searchDAO();
    await dao.deleteCodeFile(repoId, path);
  }

  // Backfill dirty-check: indexed (path, oid) pairs for one repo so unchanged
  // HEAD files skip their blob fetch and upsert entirely.
  public async getIndexedOids(repoId: string): Promise<Map<string, string | null>> {
    const dao = await this.deps.searchDAO();
    const rows = await dao.getOidsByRepo(repoId);
    const map = new Map<string, string | null>();
    for (const row of rows) map.set(row.path, row.oid);
    return map;
  }

  // Batched backfill write: indexable filtering + truncation mirror
  // indexFile, then a single D1 batch per repo. Returns rows changed.
  public async indexFiles(entries: Array<{ repoId: string; path: string; oid: string | null; content: string }>): Promise<number> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const rows: Array<{ repoId: string; path: string; oid: string | null; content: string; now: number }> = [];
    for (const entry of entries) {
      if (!SearchService.isIndexablePath(entry.path)) continue;
      if (entry.content.includes(String.fromCodePoint(0))) continue;
      rows.push({ repoId: entry.repoId, path: entry.path, oid: entry.oid, content: SearchService.truncateForIndex(entry.content), now });
    }
    if (rows.length === 0) return 0;
    const dao = await this.deps.searchDAO();
    return dao.upsertCodeFiles(rows);
  }

  // Remove index rows for paths no longer at HEAD. Only call after a
  // successful HEAD listing (see SearchDAO.deleteCodePathsNotIn).
  public async purgeStalePaths(repoId: string, keepPaths: string[]): Promise<number> {
    const dao = await this.deps.searchDAO();
    return dao.deleteCodePathsNotIn(repoId, keepPaths);
  }

  public async searchDiscussions(
    query: string,
    viewerEmail: string | null,
    opts: { limit?: number; repoId?: string } = {},
  ): Promise<DiscussionRow[]> {
    const q = SearchService.sanitizeQuery(query);
    const viewer = SearchService.normalizeViewer(viewerEmail);
    const limit = SearchService.clampLimit(opts.limit ?? 20);
    const dao = await this.deps.searchDAO();
    const candidates = await dao.searchDiscussions(q, { limit: Math.min(limit * 3, MAX_LIMIT), repoId: opts.repoId });
    const permission = await this.deps.permissionService().catch(() => this.permissionServiceSync());
    const repositoryDAO = await this.deps.repositoryDAO().catch(() => null);
    const repoCache = new Map<string, RepositoryRow | null>();
    const visible: DiscussionRow[] = [];
    for (const discussion of candidates) {
      let repo: RepositoryRow | null | undefined = repoCache.get(discussion.repository_id);
      if (repo === undefined) {
        repo = repositoryDAO ? await repositoryDAO.getById(discussion.repository_id).catch(() => null) : null;
        repoCache.set(discussion.repository_id, repo ?? null);
      }
      if (!repo) continue;
      const role = await permission.getRole(viewer, repo).catch(() => null);
      if (role) visible.push(discussion);
      if (visible.length >= limit) break;
    }
    return visible;
  }

  public async searchSnippets(query: string, opts: { limit?: number } = {}): Promise<SnippetRow[]> {
    const q = SearchService.sanitizeQuery(query);
    const limit = SearchService.clampLimit(opts.limit ?? 20);
    const dao = await this.deps.searchDAO();
    // SnippetDAO.searchSnippets already restricts to public rows.
    return dao.searchSnippets(q, { limit });
  }

  public async clearRepo(repoId: string): Promise<void> {
    const dao = await this.deps.searchDAO();
    await dao.deleteCodeByRepo(repoId);
  }
}

export { SearchService };
export type { SearchServiceDeps, SearchServiceEnv, SearchType };
