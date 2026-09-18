import { describe, expect, it } from 'vitest';
import { RepositoryDAO, SearchDAO } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { PermissionService } from '@edge-git/backend-services/permission';
import { SearchService } from '@edge-git/backend-services/search';

function createSearchFakeDb(opts: {
  repos?: Array<Record<string, unknown>>;
  issues?: Array<Record<string, unknown>>;
  code?: Array<Record<string, unknown>>;
  ftsAvailable?: boolean;
}): D1Queryable & { code: Array<Record<string, unknown>> } {
  const repos = opts.repos ?? [];
  const issues = opts.issues ?? [];
  const code = opts.code ?? [];
  const ftsAvailable = opts.ftsAvailable ?? false;

  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM repositories WHERE id = ?')) {
          return Promise.resolve((repos.find((r) => r.id === params[0]) ?? null) as T | null);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('MATCH')) {
          if (!ftsAvailable) throw new Error('no such table: repo_fts');
          // Minimal FTS emulation: substring match on the bound FTS query tokens.
          const fts = String(params[0]).toLowerCase();
          if (q.includes('FROM repo_fts')) {
            const hits = repos.filter((r) => {
              const hay = `${r.owner}/${r.name} ${r.description ?? ''}`.toLowerCase();
              const tokens = fts
                .replaceAll('"', '')
                .replaceAll('*', '')
                .split(/\s*(?:and|or)\s*/);
              return tokens.filter(Boolean).every((t) => hay.includes(t.trim()));
            });
            return Promise.resolve({ results: hits.slice(0, params[1] as number) as T[] });
          }
          const hits = issues.filter((i) => {
            const hay = `${i.title} ${i.body ?? ''}`.toLowerCase();
            const tokens = fts
              .replaceAll('"', '')
              .replaceAll('*', '')
              .split(/\s*(?:and|or)\s*/);
            return tokens.filter(Boolean).every((t) => hay.includes(t.trim()));
          });
          const scoped = params.length === 3 ? hits.filter((i) => i.repository_id === params[1]) : hits;
          return Promise.resolve({ results: scoped.slice(0, params[params.length - 1] as number) as T[] });
        }
        if (q.includes('FROM repositories WHERE')) {
          const limit = params[params.length - 1] as number;
          const patterns = (params.slice(0, -1) as string[]).map((p) => p.replaceAll('%', '').toLowerCase());
          const hits = repos.filter((r) => {
            const hay = `${r.owner} ${r.name} ${String(r.description ?? '').toLowerCase()}`;
            return patterns.every((p) => !p || hay.toLowerCase().includes(p));
          });
          return Promise.resolve({ results: hits.slice(0, limit) as T[] });
        }
        if (q.includes('FROM issues WHERE')) {
          const limit = params[params.length - 1] as number;
          const hasRepoScope = q.includes('repository_id = ?');
          const likeParams = (hasRepoScope ? params.slice(1, -1) : params.slice(0, -1)) as string[];
          const patterns = likeParams.map((p) => p.replaceAll('%', '').toLowerCase());
          let hay = issues;
          if (hasRepoScope) hay = hay.filter((i) => i.repository_id === params[0]);
          const hits = hay.filter((i) => {
            const text = `${i.title} ${i.body ?? ''}`.toLowerCase();
            return patterns.every((p) => !p || text.includes(p));
          });
          return Promise.resolve({ results: hits.slice(0, limit) as T[] });
        }
        if (q.includes('FROM code_index WHERE')) {
          const limit = params[params.length - 1] as number;
          const hasRepoScope = q.includes('repo_id = ?');
          const likeParams = (hasRepoScope ? params.slice(1, -1) : params.slice(0, -1)) as string[];
          const patterns = likeParams.map((p) => String(p).replaceAll('%', '').replaceAll('!', '').toLowerCase());
          let hay = code;
          if (hasRepoScope) hay = hay.filter((c) => c.repo_id === params[0]);
          const hits = hay.filter((c) => {
            const text = `${c.path} ${c.content}`.toLowerCase();
            return patterns.every((p) => !p || text.includes(p));
          });
          return Promise.resolve({ results: hits.slice(0, limit) as T[] });
        }
        if (q.includes('FROM repositories ORDER BY')) {
          const limit = params[0] as number;
          const offset = (params[1] as number) ?? 0;
          const sorted = [...repos].sort((a, b) => (b.updated_at as number) - (a.updated_at as number));
          return Promise.resolve({ results: sorted.slice(offset, offset + limit) as T[] });
        }
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO code_index')) {
          const [repo_id, path, oid, content, updated_at] = params as Array<string | number | null>;
          const existing = code.find((c) => c.repo_id === repo_id && c.path === path);
          if (existing) {
            existing.oid = oid;
            existing.content = content;
            existing.updated_at = updated_at;
          } else {
            code.push({ repo_id, path, oid, content, updated_at });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM code_index WHERE repo_id = ? AND path = ?')) {
          const before = code.length;
          for (let i = code.length - 1; i >= 0; i -= 1) {
            if (code[i].repo_id === params[0] && code[i].path === params[1]) code.splice(i, 1);
          }
          return Promise.resolve({ success: true, meta: { changes: before - code.length } });
        }
        if (q.startsWith('DELETE FROM code_index WHERE repo_id = ?')) {
          const before = code.length;
          for (let i = code.length - 1; i >= 0; i -= 1) {
            if (code[i].repo_id === params[0]) code.splice(i, 1);
          }
          return Promise.resolve({ success: true, meta: { changes: before - code.length } });
        }
        return Promise.resolve({ success: true });
      },
    };
  }

  return { code, prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) } as unknown as D1Queryable & {
    code: Array<Record<string, unknown>>;
  };
}

describe('SearchDAO LIKE fallback', () => {
  it('finds repos by name/description without FTS5', async () => {
    const db = createSearchFakeDb({
      repos: [
        { id: 'r1', owner: 'alice', name: 'demo-api', description: 'Demo service', is_private: 0, updated_at: 2 },
        { id: 'r2', owner: 'bob', name: 'other', description: 'Unrelated', is_private: 0, updated_at: 1 },
      ],
    });
    const dao = new SearchDAO(db);
    const hits = await dao.searchRepos('demo', { limit: 10 });
    expect(hits.map((r) => r.id)).toEqual(['r1']);
  });

  it('finds issues by title/body without FTS5', async () => {
    const db = createSearchFakeDb({
      issues: [
        { id: 'i1', repository_id: 'r1', number: 1, title: 'Login bug', body: 'fails on edge', updated_at: 1 },
        { id: 'i2', repository_id: 'r1', number: 2, title: 'Docs', body: 'readme update', updated_at: 2 },
      ],
    });
    const dao = new SearchDAO(db);
    await expect(dao.searchIssues('login', { limit: 10 })).resolves.toHaveLength(1);
    await expect(dao.searchIssues('login', { limit: 10, repoId: 'r9' })).resolves.toHaveLength(0);
  });
});

describe('SearchService', () => {
  it('rejects short/oversized queries and clamps limits', () => {
    expect(() => SearchService.sanitizeQuery('a')).toThrow('at least 2 characters');
    expect(() => SearchService.sanitizeQuery('x'.repeat(201))).toThrow('at most');
    expect(SearchService.clampLimit('999')).toBe(50);
    expect(SearchService.clampLimit('abc')).toBe(20);
    expect(SearchService.parseType('issues')).toBe('issues');
    expect(SearchService.parseType('code')).toBe('code');
    expect(SearchService.parseType('repos')).toBe('repos');
  });

  it('hides private repos from anonymous viewers', async () => {
    const db = createSearchFakeDb({
      repos: [
        { id: 'r1', owner: 'alice', name: 'demo', description: 'public demo', is_private: 0, owner_email: 'alice@x.co', updated_at: 1 },
        {
          id: 'r2',
          owner: 'alice',
          name: 'demo-secret',
          description: 'private demo',
          is_private: 1,
          owner_email: 'alice@x.co',
          updated_at: 2,
        },
      ],
    });
    const svc = new SearchService({ DB: db } as never, {
      searchDAO: () => Promise.resolve(new SearchDAO(db)),
      repositoryDAO: () => Promise.resolve(new RepositoryDAO(db)),
      permissionService: () => Promise.resolve(new PermissionService({ DB: db } as never)),
    });
    const anon = await svc.searchRepos('demo', null, 10);
    expect(anon.map((r) => r.id)).toEqual(['r1']);
    const owner = await svc.searchRepos('demo', 'alice@x.co', 10);
    expect(owner.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
  });

  it('hides issues in private repos from outsiders', async () => {
    const db = createSearchFakeDb({
      repos: [{ id: 'r1', owner: 'alice', name: 'secret', description: '', is_private: 1, owner_email: 'alice@x.co', updated_at: 1 }],
      issues: [{ id: 'i1', repository_id: 'r1', number: 1, title: 'Secret bug', body: 'private', updated_at: 1 }],
    });
    const svc = new SearchService({ DB: db } as never, {
      searchDAO: () => Promise.resolve(new SearchDAO(db)),
      repositoryDAO: () => Promise.resolve(new RepositoryDAO(db)),
      permissionService: () => Promise.resolve(new PermissionService({ DB: db } as never)),
    });
    await expect(svc.searchIssues('secret', 'bob@x.co', { limit: 10 })).resolves.toHaveLength(0);
    await expect(svc.searchIssues('secret', 'alice@x.co', { limit: 10 })).resolves.toHaveLength(1);
  });
});

describe('Code search', () => {
  function makeService(db: D1Queryable): SearchService {
    return new SearchService({ DB: db } as never, {
      searchDAO: () => Promise.resolve(new SearchDAO(db)),
      repositoryDAO: () => Promise.resolve(new RepositoryDAO(db)),
      permissionService: () => Promise.resolve(new PermissionService({ DB: db } as never)),
    });
  }

  it('indexes, finds, and removes code without FTS5', async () => {
    const db = createSearchFakeDb({
      repos: [{ id: 'r1', owner: 'alice', name: 'demo', description: '', is_private: 0, owner_email: 'alice@x.co', updated_at: 1 }],
    });
    const svc = makeService(db);
    await expect(svc.indexFile({ repoId: 'r1', path: 'src/app.ts', oid: 'abc', content: 'export function hello() {}' })).resolves.toBe(
      true,
    );
    const hits = await svc.searchCode('hello', null, { limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('src/app.ts');
    expect(hits[0].snippet).toContain('hello');
    await svc.removeFile('r1', 'src/app.ts');
    await expect(svc.searchCode('hello', null, { limit: 10 })).resolves.toHaveLength(0);
  });

  it('skips vendored paths and binary content', async () => {
    const db = createSearchFakeDb({
      repos: [{ id: 'r1', owner: 'alice', name: 'demo', description: '', is_private: 0, owner_email: 'alice@x.co', updated_at: 1 }],
    });
    const svc = makeService(db);
    await expect(svc.indexFile({ repoId: 'r1', path: 'node_modules/lib.js', oid: null, content: 'hello' })).resolves.toBe(false);
    await expect(svc.indexFile({ repoId: 'r1', path: 'bin.dat', oid: null, content: 'a' + String.fromCharCode(0) + 'b' })).resolves.toBe(
      false,
    );
    await expect(svc.searchCode('hello', null, { limit: 10 })).resolves.toHaveLength(0);
  });

  it('hides code in private repos from outsiders', async () => {
    const db = createSearchFakeDb({
      repos: [{ id: 'r1', owner: 'alice', name: 'secret', description: '', is_private: 1, owner_email: 'alice@x.co', updated_at: 1 }],
      code: [{ repo_id: 'r1', path: 'main.ts', oid: null, content: 's3cr3t token handler', updated_at: 1 }],
    });
    const svc = makeService(db);
    await expect(svc.searchCode('token', 'bob@x.co', { limit: 10 })).resolves.toHaveLength(0);
    await expect(svc.searchCode('token', 'alice@x.co', { limit: 10 })).resolves.toHaveLength(1);
  });
});
