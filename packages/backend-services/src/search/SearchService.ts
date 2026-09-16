import { IssueDAO, RepositoryDAO, SearchDAO } from '@edge-git/backend-data/dao';
import type { CodeHit, IssueRow, RepositoryRow } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError } from '@edge-git/backend-errors';
import { TimestampUtil } from '@edge-git/shared/utils';
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

type SearchType = 'repos' | 'issues' | 'code';

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
    if (raw === 'code') return 'code';
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
    return new PermissionService(this.env);
  }

  public async searchRepos(query: string, viewerEmail: string | null, limit = 20): Promise<RepositoryRow[]> {
    const q = SearchService.sanitizeQuery(query);
    const dao = await this.deps.searchDAO();
    // Over-fetch candidates, then filter private rows via PermissionService.
    const candidates = await dao.searchRepos(q, { limit: Math.min(limit * 3, MAX_LIMIT) });
    const permission = await this.deps.permissionService().catch(() => this.permissionServiceSync());
    const visible: RepositoryRow[] = [];
    for (const row of candidates) {
      const role = await permission.getRole(viewerEmail, row).catch(() => null);
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
      const role = await permission.getRole(viewerEmail, repo).catch(() => null);
      if (role) visible.push(issue);
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
      const role = await permission.getRole(viewerEmail, repo).catch(() => null);
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

  public async clearRepo(repoId: string): Promise<void> {
    const dao = await this.deps.searchDAO();
    await dao.deleteCodeByRepo(repoId);
  }
}

/**
@deprecated Prefer `createRequestScope(env).get(Tokens.SearchService)`; kept for backward compatibility.
*/
class SearchServiceFactory {
  public static create(env: SearchServiceEnv): SearchService {
    return new SearchService(env);
  }
}

export { SearchService, SearchServiceFactory };
export type { SearchServiceDeps, SearchServiceEnv, SearchType };
