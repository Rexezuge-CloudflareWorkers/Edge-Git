import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { DatabaseError } from '@edge-git/backend-errors';
import { NumberingDAO } from '@edge-git/backend-data/dao';
import { IssueService } from '@edge-git/backend-services/issue';
import { PermissionService } from '@edge-git/backend-services/permission';
import type { RepositoryRow } from '@edge-git/backend-data/dao';
import { allocateNumberWithFallback } from '@edge-git/backend-services/numbering/numberAllocator';
import { workerFetchAdapter } from '@edge-git/background/transfer/fetchAdapter';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import { SPA_HTML } from '@/generated/spa-shell';
import { resetRateLimitForTests } from '@/middleware/rateLimit';

// --- NumberingDAO -----------------------------------------------------------

function numberingFake(seedIssues: Array<{ repository_id: string; number: number }> = []) {
  const counters = new Map<string, number>();
  const db = {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>() {
              if (!query.includes('repo_number_counters')) return null;
              const [repoId, entity] = params as [string, string];
              const key = `${repoId}:${entity}`;
              if (!counters.has(key)) {
                const max = seedIssues
                  .filter((i) => i.repository_id === repoId)
                  .reduce((m, i) => Math.max(m, i.number), 0);
                counters.set(key, max + 2);
              }
              const current = counters.get(key) as number;
              counters.set(key, current + 1);
              return { n: current - 1 } as unknown as T;
            },
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true };
            },
          };
        },
      };
    },
  };
  return db as unknown as D1Queryable;
}

describe('slice3: NumberingDAO atomic allocator', () => {
  it('hands out 1, 2, 3 sequentially per repo+entity', async () => {
    const dao = new NumberingDAO(numberingFake());
    expect(await dao.allocateNumber('r1', 'issue')).toBe(1);
    expect(await dao.allocateNumber('r1', 'issue')).toBe(2);
    expect(await dao.allocateNumber('r1', 'pull')).toBe(1);
    expect(await dao.allocateNumber('r2', 'issue')).toBe(1);
  });

  it('seeds above pre-existing MAX(number) rows', async () => {
    const dao = new NumberingDAO(numberingFake([{ repository_id: 'r1', number: 5 }]));
    expect(await dao.allocateNumber('r1', 'issue')).toBe(6);
    expect(await dao.allocateNumber('r1', 'issue')).toBe(7);
  });

  it('rejects unknown entities before touching SQL', async () => {
    const dao = new NumberingDAO(numberingFake());
    await expect(dao.allocateNumber('r1', 'release' as never)).rejects.toThrow('Unknown numbered entity');
  });

  it('throws a missing-schema-style error when the table is absent', async () => {
    const dao = new NumberingDAO({ prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) }) }) } as unknown as D1Queryable);
    await expect(dao.allocateNumber('r1', 'issue')).rejects.toThrow('no such table: repo_number_counters');
  });
});

describe('slice3: allocateNumberWithFallback', () => {
  it('prefers the allocator and skips the legacy reader', async () => {
    const legacy = vi.fn(async () => 99);
    const n = await allocateNumberWithFallback(async () => new NumberingDAO(numberingFake()), legacy, 'r1', 'issue');
    expect(n).toBe(1);
    expect(legacy).not.toHaveBeenCalled();
  });

  it('falls back to MAX+1 when the table is missing', async () => {
    const broken = async () => ({ allocateNumber: async () => Promise.reject(new Error('no such table: repo_number_counters')) }) as never;
    const n = await allocateNumberWithFallback(broken, async () => 4, 'r1', 'issue');
    expect(n).toBe(4);
  });
});

describe('slice3: IssueService numbering paths', () => {
  function issueFakeDb(counters: boolean) {
    const issues: Array<Record<string, unknown>> = [];
    return {
      issues,
      prepare(query: string) {
        const q = query.replace(/\s+/g, ' ').trim();
        return {
          bind(...params: unknown[]) {
            return {
              async first<T>() {
                if (q.includes('repo_number_counters')) {
                  if (!counters) return null;
                  const [repoId] = params as [string];
                  const max = issues.filter((i) => i.repository_id === repoId).reduce((m, i) => Math.max(m, i.number as number), 0);
                  issues.push({ repository_id: repoId, number: max + 1, __counter: true });
                  return { n: max + 1 } as unknown as T;
                }
                if (q.startsWith('SELECT COALESCE(MAX(number)')) {
                  const max = issues
                    .filter((i) => i.repository_id === params[0] && !i.__counter)
                    .reduce((m, i) => Math.max(m, i.number as number), 0);
                  return { max_n: max } as unknown as T;
                }
                return null;
              },
              async all() {
                return { results: [] };
              },
              async run() {
                if (q.startsWith('INSERT INTO issues')) {
                  issues.push({ repository_id: params[1], number: params[3] });
                }
                return { success: true };
              },
            };
          },
        };
      },
    } as unknown as D1Queryable & { issues: Array<Record<string, unknown>> };
  }

  function baseInput(n: number) {
    return { repositoryId: 'r1', fullName: 'alice/demo', title: `t${n}`, creatorEmail: 'alice@example.com' };
  }

  it('hands out distinct numbers under concurrent creates (allocator)', async () => {
    const db = issueFakeDb(true);
    const service = new IssueService({ DB: db });
    const results = await Promise.all([service.createIssue(baseInput(1)), service.createIssue(baseInput(2)), service.createIssue(baseInput(3))]);
    expect(new Set(results.map((r) => r.number)).size).toBe(3);
  });

  it('still creates via MAX+1 when counters are absent (legacy/fakes)', async () => {
    const db = issueFakeDb(false);
    const service = new IssueService({ DB: db });
    const created = await service.createIssue(baseInput(1));
    expect(created.number).toBe(1);
  });
});

// --- PermissionService strictSchema -----------------------------------------

function strictDeps(overrides: Record<string, unknown> = {}) {
  const missing = async (): Promise<never> => {
    throw new Error('no such table: team_repo_grants');
  };
  return {
    organizationDAO: async () => ({ getByUsernameCi: async () => null }),
    organizationMemberDAO: async () => ({ get: async () => ({ role: 'member' }) }),
    repoCollaboratorDAO: async () => ({ get: async () => null }),
    namespaceDAO: async () => ({ get: async () => null }),
    teamDAO: async () => ({ getById: async () => null }),
    teamMemberDAO: async () => ({ get: async () => null }),
    teamGrantDAO: async () => ({ listByRepo: missing }),
    ...overrides,
  } as never;
}

function orgRepo(): RepositoryRow {
  return {
    id: 'r1',
    owner_email: 'alice@example.com',
    owner: 'acme',
    name: 'demo',
    description: null,
    is_private: 0,
    created_at: 1,
    updated_at: 1,
    owner_type: 'org',
    owner_ci: 'acme',
    name_ci: 'demo',
    owner_user_email: null,
    org_id: 'org-1',
  };
}

describe('slice3: PermissionService strictSchema', () => {
  it('fails closed on missing team-grant tables in strict mode', async () => {
    const service = new PermissionService({ DB: {} as never }, { ...strictDeps(), strictSchema: true });
    await expect(service.getRole('bob@example.com', orgRepo())).rejects.toBeInstanceOf(DatabaseError);
  });

  it('degrades to public read without strict mode (legacy DBs/fakes)', async () => {
    const service = new PermissionService({ DB: {} as never }, strictDeps());
    await expect(service.getRole('bob@example.com', orgRepo())).resolves.toBe('read');
  });

  it('fails closed on missing org tables in strict mode', async () => {
    const deps = strictDeps({
      organizationDAO: async () => ({
        getByUsernameCi: async (): Promise<never> => {
          throw new Error('no such table: organizations');
        },
      }),
    });
    const repo = { ...orgRepo(), org_id: null };
    const strict = new PermissionService({ DB: {} as never }, { ...deps, strictSchema: true });
    await expect(strict.getRole('bob@example.com', repo)).rejects.toBeInstanceOf(DatabaseError);
    const lax = new PermissionService({ DB: {} as never }, deps);
    await expect(lax.getRole('bob@example.com', repo)).resolves.toBe('read');
  });
});

// --- fetchAdapter redirect loops --------------------------------------------

function withFetchStub(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(handler(String(url), init));
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

describe('slice3: fetchAdapter redirect loops', () => {
  const signal = () => new AbortController().signal;

  it('fails fast on A→B→A cycles instead of burning the hop budget', async () => {
    const stub = withFetchStub((url) => {
      if (url === 'https://github.com/a') return new Response(null, { status: 302, headers: { location: 'https://github.com/b' } });
      return new Response(null, { status: 302, headers: { location: 'https://github.com/a' } });
    });
    try {
      await expect(workerFetchAdapter().get('https://github.com/a', {}, signal())).rejects.toThrow(/redirect loop/);
      expect(stub.calls.map((c) => c.url)).toEqual(['https://github.com/a', 'https://github.com/b']);
    } finally {
      stub.restore();
    }
  });

  it('rejects https→http downgrades before firing', async () => {
    const stub = withFetchStub(() => new Response(null, { status: 302, headers: { location: 'http://github.com/evil' } }));
    try {
      await expect(workerFetchAdapter().get('https://github.com/o/r', {}, signal())).rejects.toThrow();
      expect(stub.calls).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  it('follows relative dot-segment redirects on the same public host', async () => {
    const stub = withFetchStub((url) => {
      if (url === 'https://github.com/o/r') return new Response(null, { status: 302, headers: { location: '/o/../evil' } });
      return new Response('ok', { status: 200 });
    });
    try {
      const out = await workerFetchAdapter().get('https://github.com/o/r', {}, signal());
      expect(out.status).toBe(200);
      expect(stub.calls.map((c) => c.url)).toEqual(['https://github.com/o/r', 'https://github.com/evil']);
    } finally {
      stub.restore();
    }
  });
});

// --- SPA catch-all table ----------------------------------------------------

describe('slice3: SPA catch-all route table', () => {
  const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };

  beforeEach(() => {
    resetRateLimitForTests();
  });

  async function get(path: string, env: Record<string, unknown> = {}): Promise<Response> {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    return worker.onRequest(new Request(`https://git.example.com${path}`), env as Env, CTX);
  }

  // Compares against the imported shell constant instead of a hardcoded
  // marker: `spa-shell.ts` is gitignored and generated — CI runs against the
  // empty postinstall stub while local checkouts may hold a built shell.
  // What this suite locks is the ROUTE TABLE (shell vs 404 vs auth gate),
  // not the build artifact body.
  async function expectShell(path: string, env: Record<string, unknown> = {}): Promise<void> {
    const res = await get(path, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(SPA_HTML);
  }

  it('serves the shell for app roots and repo pages', async () => {
    // NOTE: `/search` is intentionally absent here — SearchRoutes claims
    // `GET /search` as a JSON API before the catch-all (locked below).
    for (const path of ['/', '/new', '/settings', '/notifications', '/snippets']) {
      await expectShell(path);
    }
    await expectShell('/alice');
    await expectShell('/alice/demo');
    await expectShell('/alice/demo/issues/12');
    await expectShell('/alice/demo/pulls/3');
    await expectShell(`/alice/demo/commit/${'a'.repeat(40)}`);
    await expectShell('/alice/demo/compare');
    await expectShell('/alice/demo/commits');
  });

  it('never shadows reserved API/UI roots', async () => {
    for (const path of ['/health', '/docs', '/repos', '/users', '/user', '/api']) {
      const res = await get(`/${path}`);
      expect(res.status).not.toBe(200);
    }
    expect((await get('/health')).status).toBe(200);
  });

  it('returns 404 for unknown deep paths (documents the /:repo/:tab gap)', async () => {
    expect((await get('/alice/demo/releases')).status).toBe(404);
    expect((await get('/alice/demo/foo/bar')).status).toBe(404);
    expect((await get('/alice/demo/issues')).status).toBe(404);
  });

  it('leaves /search to the JSON API instead of the shell', async () => {
    const res = await get('/search?q=test');
    expect(res.headers.get('content-type')).not.toContain('text/html');
  });

  it('gates /user/* behind auth before the shell', async () => {
    expect((await get('/user/alice')).status).toBe(401);
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ success: true }),
        }),
      }),
    } as unknown as D1Queryable;
    await expectShell('/user/alice', { DB: db, ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'alice@example.com' });
  });
});
