import { describe, expect, it } from 'vitest';
import { PktLine } from '@edge-git/git-protocol';
import { workerFetchAdapter } from '@edge-git/background/transfer/fetchAdapter';
import { SearchBackfillTask } from '@edge-git/background/scheduled/SearchBackfillTask';
import { SEARCH_TICK_CRON, isSearchTick, runScheduledTasks } from '@edge-git/background/scheduled/TaskRegistry';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
import { ImportSweeperTask } from '@edge-git/background/scheduled/ImportSweeperTask';
import { CheckPruneTask } from '@edge-git/background/scheduled/CheckPruneTask';
import { CheckStaleTask } from '@edge-git/background/scheduled/CheckStaleTask';
import { MirrorSyncTask } from '@edge-git/background/scheduled/MirrorSyncTask';
import type { D1Queryable } from '@edge-git/backend-data/utils';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

function textBlob(text: string): { contentBase64: string; isBinary: boolean } {
  return { contentBase64: Buffer.from(text, 'utf8').toString('base64'), isBinary: false };
}

function advertisement(): Uint8Array {
  return PktLine.mergeLines([
    PktLine.encode('# service=git-upload-pack\n'),
    PktLine.encodeFlush(),
    PktLine.encode(`${NEW} refs/heads/main\n`),
    PktLine.encodeFlush(),
  ]);
}

function packResponse(): Uint8Array {
  const pack = new Uint8Array([...new TextEncoder().encode('PACK'), 0, 0, 0, 2, 0, 0, 0, 1, 7, 8, 9]);
  return PktLine.mergeLines([PktLine.encode('NAK\n'), PktLine.encodeSideband(1, pack)]);
}

function withFetchStub(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const realFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(handler(String(url), init));
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

interface FakeTables {
  repos: Array<Record<string, unknown>>;
  imports: Array<Record<string, unknown>>;
  mirrors: Array<Record<string, unknown>>;
  checks: Array<Record<string, unknown>>;
  codeIndex: Array<Record<string, unknown>>;
}

function seedTables(partial: Partial<FakeTables> = {}): FakeTables {
  return { repos: [], imports: [], mirrors: [], checks: [], codeIndex: [], ...partial };
}

function repoRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'r1', owner: 'alice', name: 'demo', owner_email: 'a@x.com', updated_at: 100, created_at: 1, ...overrides };
}

function checkRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'run-1',
    repository_id: 'repo-1',
    head_sha: OLD,
    context: 'secret-scan',
    status: 'queued',
    conclusion: null,
    details_url: null,
    output_title: null,
    output_summary: null,
    creator_email: 'a@x.com',
    created_at: 1000,
    updated_at: 1000,
    completed_at: null,
    ...overrides,
  };
}

function createFakeDb(tables: FakeTables): D1Queryable {
  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM repositories WHERE id = ?')) {
          return Promise.resolve((tables.repos.find((r) => r.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM repo_imports WHERE id = ?')) {
          return Promise.resolve((tables.imports.find((i) => i.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM repo_mirrors WHERE repository_id = ?')) {
          return Promise.resolve((tables.mirrors.find((m) => m.repository_id === params[0]) ?? null) as T | null);
        }
        if (q.startsWith('SELECT * FROM check_runs WHERE id = ? AND repository_id = ?')) {
          const row = tables.checks.find((r) => r.id === params[0] && r.repository_id === params[1]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.startsWith('SELECT * FROM check_runs WHERE repository_id = ? AND head_sha = ? AND context = ?')) {
          const row = tables.checks.find((r) => r.repository_id === params[0] && r.head_sha === params[1] && r.context === params[2]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.startsWith('SELECT COUNT(*) AS n FROM check_runs')) {
          const n = tables.checks.filter((r) => r.repository_id === params[0] && r.head_sha === params[1]).length;
          return Promise.resolve({ n } as unknown as T);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM repositories ORDER BY updated_at DESC')) {
          const limit = params[0] as number;
          const offset = (params[1] as number) ?? 0;
          const rows = [...tables.repos].sort((a, b) => (b.updated_at as number) - (a.updated_at as number)).slice(offset, offset + limit);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.startsWith("SELECT * FROM repo_imports WHERE status = 'pending'")) {
          const cutoff = params[0] as number;
          const limit = params[1] as number;
          const rows = tables.imports
            .filter((i) => i.status === 'pending' || (i.status === 'running' && (i.updated_at as number) < cutoff))
            .sort((a, b) => (a.created_at as number) - (b.created_at as number))
            .slice(0, limit);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.startsWith('SELECT * FROM repo_mirrors WHERE enabled = 1')) {
          const now = params[0] as number;
          const limit = params[1] as number;
          const rows = tables.mirrors
            .filter(
              (m) => m.enabled === 1 && (m.last_run_at === null || (m.last_run_at as number) + (m.interval_minutes as number) * 60 <= now),
            )
            .slice(0, limit);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM check_runs WHERE status IN (')) {
          const limit = params[params.length - 1] as number;
          const olderThan = params[params.length - 2] as number;
          const statuses = params.slice(0, -2) as string[];
          const rows = tables.checks
            .filter((r) => statuses.includes(r.status as string) && (r.updated_at as number) < olderThan)
            .slice(0, limit);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.startsWith('SELECT path, oid FROM code_index WHERE repo_id = ?')) {
          const rows = tables.codeIndex.filter((c) => c.repo_id === params[0]).map((c) => ({ path: c.path, oid: c.oid }));
          return Promise.resolve({ results: rows as T[] });
        }
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO check_runs')) {
          const [
            id,
            repository_id,
            head_sha,
            context,
            status,
            conclusion,
            details_url,
            output_title,
            output_summary,
            creator_email,
            created_at,
            updated_at,
            completed_at,
          ] = params as Array<string | number | null>;
          tables.checks.push({
            id,
            repository_id,
            head_sha,
            context,
            status,
            conclusion,
            details_url,
            output_title,
            output_summary,
            creator_email,
            created_at,
            updated_at,
            completed_at,
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE check_runs SET status = ?')) {
          const [status, conclusion, details_url, output_title, output_summary, updated_at, completed_at, id, repository_id] =
            params as Array<string | number | null>;
          const row = tables.checks.find((r) => r.id === id && r.repository_id === repository_id);
          if (row) {
            Object.assign(row, { status, conclusion, details_url, output_title, output_summary, updated_at, completed_at });
            return Promise.resolve({ success: true, meta: { changes: 1 } });
          }
          return Promise.resolve({ success: true, meta: { changes: 0 } });
        }
        if (q.startsWith('DELETE FROM check_runs')) {
          const [cutoff, limit] = params as [number, number];
          const victims = tables.checks.filter((r) => (r.created_at as number) < cutoff).slice(0, limit);
          for (const victim of victims) tables.checks.splice(tables.checks.indexOf(victim), 1);
          return Promise.resolve({ success: true, meta: { changes: victims.length } });
        }
        if (q.startsWith("UPDATE repo_imports SET status = 'running'")) {
          const [now, id] = params as [number, string];
          const row = tables.imports.find((i) => i.id === id);
          if (row) {
            row.status = 'running';
            row.updated_at = now;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith("UPDATE repo_imports SET status = 'failed'")) {
          const [error, now, id] = params as [string, number, string];
          const row = tables.imports.find((i) => i.id === id && ['pending', 'running'].includes(i.status as string));
          if (row) {
            row.status = 'failed';
            row.error = error;
            row.updated_at = now;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith("UPDATE repo_imports SET status = 'done'")) {
          const [importedRefs, now, id] = params as [number, number, string];
          const row = tables.imports.find((i) => i.id === id && ['pending', 'running'].includes(i.status as string));
          if (row) {
            row.status = 'done';
            row.imported_refs = importedRefs;
            row.updated_at = now;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith("UPDATE repo_mirrors SET last_run_at = ?, last_status = 'ok'")) {
          const [now, , id] = params as [number, number, string];
          const row = tables.mirrors.find((m) => m.repository_id === id);
          if (row) {
            row.last_run_at = now;
            row.last_status = 'ok';
            row.last_error = null;
            row.consecutive_failures = 0;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes('consecutive_failures = consecutive_failures + 1')) {
          const [now, error, maxFailures, , id] = params as [number, string, number, number, string];
          const row = tables.mirrors.find((m) => m.repository_id === id);
          if (row) {
            row.last_run_at = now;
            row.last_status = 'failed';
            row.last_error = error;
            row.consecutive_failures = (row.consecutive_failures as number) + 1;
            if ((row.consecutive_failures as number) >= maxFailures) row.enabled = 0;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repo_mirrors')) {
          tables.mirrors = tables.mirrors.filter((m) => m.repository_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO code_index')) {
          const [repo_id, path, oid, content, updated_at] = params as [string, string, string | null, string, number];
          const existing = tables.codeIndex.find((c) => c.repo_id === repo_id && c.path === path);
          if (existing) {
            // Emulate the conditional upsert WHERE clause.
            if (existing.oid === oid && existing.content === content) {
              return Promise.resolve({ success: true, meta: { changes: 0 } });
            }
            Object.assign(existing, { oid, content, updated_at });
          } else tables.codeIndex.push({ repo_id, path, oid, content, updated_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM code_index WHERE repo_id = ? AND path NOT IN (')) {
          const before = tables.codeIndex.length;
          const keep = new Set((params.slice(1) as unknown[]).map(String));
          tables.codeIndex = tables.codeIndex.filter((c) => c.repo_id !== params[0] || keep.has(String(c.path)));
          return Promise.resolve({ success: true, meta: { changes: before - tables.codeIndex.length } });
        }
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      },
    };
  }
  return { prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) } as unknown as D1Queryable;
}

function smartHttpStub() {
  return withFetchStub((url) => {
    if (url.includes('/info/refs')) {
      return new Response(advertisement() as unknown as BodyInit, {
        status: 200,
        headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' },
      });
    }
    return new Response(packResponse() as unknown as BodyInit, { status: 200 });
  });
}

describe('SearchBackfillTask catch-up', () => {
  it('indexes HEAD text files for recently updated repos', async () => {
    const tables = seedTables({ repos: [repoRow({ id: 'r1' })] });
    const db = createFakeDb(tables);
    const blobs: Record<string, string> = { 'README.md': '# Demo', 'src/app.ts': 'export const a = 1;' };
    const env = {
      DB: db,
      REPO: {
        getByName: () => ({
          listAllFiles: async () => Object.keys(blobs).map((path) => ({ path, oid: OLD })),
          getBlob: async ({ filepath }: { filepath: string }) => (blobs[filepath] ? textBlob(blobs[filepath] as string) : null),
        }),
      },
    } as unknown as Env;
    await new SearchBackfillTask().run(env);
    expect(tables.codeIndex).toHaveLength(2);
    expect(tables.codeIndex.map((c) => c.path).sort()).toEqual(['README.md', 'src/app.ts']);
  });

  it('skips binary and oversize blobs without failing the tick', async () => {
    const tables = seedTables({ repos: [repoRow({ id: 'r1' })] });
    const db = createFakeDb(tables);
    const env = {
      DB: db,
      REPO: {
        getByName: () => ({
          listAllFiles: async () => [
            { path: 'ok.txt', oid: OLD },
            { path: 'bin.dat', oid: OLD },
            { path: 'big.txt', oid: OLD },
          ],
          getBlob: async ({ filepath }: { filepath: string }) => {
            if (filepath === 'ok.txt') return textBlob('hello');
            if (filepath === 'bin.dat') return { contentBase64: textBlob('hi').contentBase64, isBinary: true };
            return textBlob('x'.repeat(30000));
          },
        }),
      },
    } as unknown as Env;
    await new SearchBackfillTask().run(env);
    expect(tables.codeIndex.map((c) => c.path)).toEqual(['ok.txt']);
  });

  it('isolates per-repo failures so one bad repo never starves the rest', async () => {
    const tables = seedTables({ repos: [repoRow({ id: 'r1', name: 'bad' }), repoRow({ id: 'r2', name: 'good', updated_at: 200 })] });
    const db = createFakeDb(tables);
    const env = {
      DB: db,
      REPO: {
        getByName: (name: string) => {
          if (String(name).endsWith('/bad'))
            return {
              listAllFiles: async () => {
                throw new Error('do down');
              },
            };
          return {
            listAllFiles: async () => [{ path: 'README.md', oid: OLD }],
            getBlob: async () => textBlob('hi'),
          };
        },
      },
    } as unknown as Env;
    await new SearchBackfillTask().run(env);
    expect(tables.codeIndex.filter((c) => c.repo_id === 'r2')).toHaveLength(1);
  });

  it('never throws when the repo listing fails', async () => {
    const broken = {
      prepare: () => {
        throw new Error('d1 down');
      },
    } as unknown as D1Queryable;
    const env = {
      DB: broken,
      REPO: {
        getByName: () => {
          throw new Error('must not be called');
        },
      },
    } as unknown as Env;
    await expect(new SearchBackfillTask().run(env)).resolves.toBeUndefined();
  });

  it('caps indexed files per repo at the backfill budget', async () => {
    const tables = seedTables({ repos: [repoRow({ id: 'r1' })] });
    const db = createFakeDb(tables);
    const paths = Array.from({ length: 60 }, (_, i) => `file-${i}.txt`);
    const env = {
      DB: db,
      REPO: {
        getByName: () => ({
          listAllFiles: async () => paths.map((path) => ({ path, oid: OLD })),
          getBlob: async () => textBlob('content'),
        }),
      },
    } as unknown as Env;
    await new SearchBackfillTask().run(env);
    expect(tables.codeIndex.length).toBeLessThanOrEqual(50);
    expect(tables.codeIndex.length).toBeGreaterThan(0);
  });

  it('skips unchanged files without fetching blobs', async () => {
    const tables = seedTables({
      repos: [repoRow({ id: 'r1' })],
      codeIndex: [
        { repo_id: 'r1', path: 'same.ts', oid: OLD, content: 'same', updated_at: 50 },
        { repo_id: 'r1', path: 'changed.ts', oid: 'c'.repeat(40), content: 'old', updated_at: 50 },
      ],
    });
    const db = createFakeDb(tables);
    const blobCalls: string[] = [];
    const env = {
      DB: db,
      REPO: {
        getByName: () => ({
          listAllFiles: async () => [
            { path: 'same.ts', oid: OLD },
            { path: 'changed.ts', oid: OLD },
          ],
          getBlob: async ({ filepath }: { filepath: string }) => {
            blobCalls.push(filepath);
            return textBlob(`content of ${filepath}`);
          },
        }),
      },
    } as unknown as Env;
    await new SearchBackfillTask().run(env);
    expect(blobCalls).toEqual(['changed.ts']);
    expect(tables.codeIndex).toHaveLength(2);
    expect(tables.codeIndex.find((c) => c.path === 'changed.ts')).toMatchObject({ oid: OLD });
    expect(tables.codeIndex.find((c) => c.path === 'same.ts')).toMatchObject({ updated_at: 50 });
  });

  it('purges index rows for paths deleted from HEAD', async () => {
    const tables = seedTables({
      repos: [repoRow({ id: 'r1' })],
      codeIndex: [
        { repo_id: 'r1', path: 'keep.ts', oid: OLD, content: 'keep', updated_at: 50 },
        { repo_id: 'r1', path: 'gone.ts', oid: OLD, content: 'gone', updated_at: 50 },
      ],
    });
    const db = createFakeDb(tables);
    const env = {
      DB: db,
      REPO: {
        getByName: () => ({
          listAllFiles: async () => [{ path: 'keep.ts', oid: OLD }],
          getBlob: async () => textBlob('keep'),
        }),
      },
    } as unknown as Env;
    await new SearchBackfillTask().run(env);
    expect(tables.codeIndex.map((c) => c.path)).toEqual(['keep.ts']);
  });

  it('never purges when the HEAD listing fails', async () => {
    const tables = seedTables({
      repos: [repoRow({ id: 'r1' })],
      codeIndex: [{ repo_id: 'r1', path: 'keep.ts', oid: OLD, content: 'keep', updated_at: 50 }],
    });
    const db = createFakeDb(tables);
    const env = {
      DB: db,
      REPO: {
        getByName: () => ({
          listAllFiles: async () => {
            throw new Error('do down');
          },
        }),
      },
    } as unknown as Env;
    await new SearchBackfillTask().run(env);
    expect(tables.codeIndex).toHaveLength(1);
  });

  it('routes repo reads via the canonical lowercase DO key', async () => {
    const tables = seedTables({ repos: [repoRow({ id: 'r1', owner: 'PublicMirror', name: 'AWS-AccessBridge' })] });
    const db = createFakeDb(tables);
    const seen: string[] = [];
    const env = {
      DB: db,
      REPO: {
        getByName: (key: string) => {
          seen.push(key);
          return {
            listAllFiles: async () => [{ path: 'README.md', oid: OLD }],
            getBlob: async () => textBlob('hi'),
          };
        },
      },
    } as unknown as Env;
    await new SearchBackfillTask().run(env);
    // Mixed-case repos must index the same canonical isolate that API reads
    // address, or search silently indexes an orphaned (empty) DO.
    expect(seen).toEqual(['publicmirror/aws-accessbridge']);
    expect(tables.codeIndex).toHaveLength(1);
  });
});

describe('SearchBackfill scheduling', () => {
  it('routes search to the 4h tick only', () => {
    expect(SEARCH_TICK_CRON).toBe('7 */4 * * *');
    expect(isSearchTick('')).toBe(true);
    expect(isSearchTick('7 */4 * * *')).toBe(true);
    expect(isSearchTick('*/10 * * * *')).toBe(false);
  });

  it('skips DO work on the fast tick but indexes on the search tick', async () => {
    const fastTables = seedTables({ repos: [repoRow({ id: 'r1' })] });
    let fastCalls = 0;
    const fastEnv = {
      DB: createFakeDb(fastTables),
      REPO: {
        getByName: () => ({
          listAllFiles: async () => {
            fastCalls += 1;
            return [];
          },
          getBlob: async () => null,
        }),
      },
    } as unknown as Env;
    await runScheduledTasks(fastEnv, '*/10 * * * *', Date.now());
    expect(fastCalls).toBe(0);
    expect(fastTables.codeIndex).toHaveLength(0);

    const slowTables = seedTables({ repos: [repoRow({ id: 'r1' })] });
    let slowCalls = 0;
    const slowEnv = {
      DB: createFakeDb(slowTables),
      REPO: {
        getByName: () => ({
          listAllFiles: async () => {
            slowCalls += 1;
            return [{ path: 'a.ts', oid: OLD }];
          },
          getBlob: async () => textBlob('hi'),
        }),
      },
    } as unknown as Env;
    await runScheduledTasks(slowEnv, '7 */4 * * *', Date.now());
    expect(slowCalls).toBe(1);
    expect(slowTables.codeIndex).toHaveLength(1);
  });

  it('search backfill tunables default with env overrides', () => {
    expect(new AppConfiguration({}).getSearchBackfillIntervalSeconds()).toBe(14400);
    expect(new AppConfiguration({}).getSearchBackfillReposPerTick()).toBe(8);
    expect(new AppConfiguration({}).getSearchBackfillFilesPerRepo()).toBe(50);
    expect(new AppConfiguration({ SEARCH_BACKFILL_INTERVAL_SECONDS: '3600' }).getSearchBackfillIntervalSeconds()).toBe(3600);
    expect(new AppConfiguration({ SEARCH_BACKFILL_REPOS_PER_TICK: '3' }).getSearchBackfillReposPerTick()).toBe(3);
  });
});

describe('ImportSweeperTask stale cleanup', () => {
  function importJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'j1',
      repository_id: 'r1',
      source_url: 'https://github.com/o/r',
      status: 'pending',
      error: null,
      refs_json: null,
      imported_refs: 0,
      created_by: 'a@x.com',
      created_at: 10,
      updated_at: 10,
      ...overrides,
    };
  }

  it('runs due pending jobs to done over Smart HTTP', async () => {
    const tables = seedTables({ repos: [repoRow({ id: 'r1' })], imports: [importJob()] });
    const db = createFakeDb(tables);
    let imported = 0;
    const env = {
      DB: db,
      REPO: {
        getByName: () => ({
          listRefs: async () => ({ refs: [], symbolicHead: null }),
          importPack: async () => {
            imported += 1;
            return { importedRefs: ['refs/heads/main'] };
          },
        }),
      },
    } as unknown as Env;
    const stub = smartHttpStub();
    try {
      await new ImportSweeperTask().run(env);
    } finally {
      stub.restore();
    }
    expect(imported).toBe(1);
    expect(tables.imports[0]).toMatchObject({ status: 'done', imported_refs: 1 });
  });

  it('marks jobs failed when the repository is gone', async () => {
    const tables = seedTables({ imports: [importJob()] });
    const db = createFakeDb(tables);
    const env = {
      DB: db,
      REPO: {
        getByName: () => {
          throw new Error('must not be called');
        },
      },
    } as unknown as Env;
    const stub = smartHttpStub();
    try {
      await new ImportSweeperTask().run(env);
    } finally {
      stub.restore();
    }
    expect(tables.imports[0]).toMatchObject({ status: 'failed' });
    expect(String(tables.imports[0]?.error)).toContain('no longer exists');
  });

  it('reclaims stale-running jobs for retry', async () => {
    const tables = seedTables({ repos: [repoRow({ id: 'r1' })], imports: [importJob({ id: 'stale', status: 'running', updated_at: 1 })] });
    const db = createFakeDb(tables);
    const env = {
      DB: db,
      REPO: {
        getByName: () => ({
          listRefs: async () => ({ refs: [{ ref: 'refs/heads/main', oid: OLD }], symbolicHead: 'refs/heads/main' }),
          importPack: async () => ({ importedRefs: [] as string[] }),
        }),
      },
    } as unknown as Env;
    await new ImportSweeperTask().run(env);
    expect(tables.imports[0]?.status).toBe('failed');
  });

  it('never throws when the claim query fails', async () => {
    const broken = {
      prepare: () => {
        throw new Error('d1 down');
      },
    } as unknown as D1Queryable;
    const env = {
      DB: broken,
      REPO: {
        getByName: () => {
          throw new Error('must not be called');
        },
      },
    } as unknown as Env;
    await expect(new ImportSweeperTask().run(env)).resolves.toBeUndefined();
  });
});

describe('check retention and stuck-context pruning', () => {
  it('prunes check runs older than the retention window', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tables = seedTables({
      checks: [
        checkRow({ id: 'old', created_at: now - 100 * 86400 }),
        checkRow({ id: 'fresh', context: 'diff-limit', created_at: now - 10 * 86400 }),
      ],
    });
    await new CheckPruneTask().run({ DB: createFakeDb(tables) } as unknown as Env);
    expect(tables.checks.map((r) => r.id)).toEqual(['fresh']);
  });

  it('honors CHECK_RETENTION_DAYS overrides', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tables = seedTables({ checks: [checkRow({ id: 'mid', created_at: now - 31 * 86400 })] });
    await new CheckPruneTask().run({ DB: createFakeDb(tables), CHECK_RETENTION_DAYS: '30' } as unknown as Env);
    expect(tables.checks).toHaveLength(0);
  });

  it('marks stale queued and in_progress runs timed_out', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tables = seedTables({
      checks: [
        checkRow({ id: 'q-old', status: 'queued', updated_at: now - 7200 }),
        checkRow({ id: 'p-old', context: 'diff-limit', status: 'in_progress', updated_at: now - 7200 }),
        checkRow({ id: 'q-fresh', context: 'codeowners-exists', updated_at: now }),
      ],
    });
    await new CheckStaleTask().run({ DB: createFakeDb(tables) } as unknown as Env);
    const byId = new Map(tables.checks.map((r) => [r.id, r]));
    expect(byId.get('q-old')).toMatchObject({ status: 'completed', conclusion: 'timed_out' });
    expect(byId.get('p-old')).toMatchObject({ status: 'completed', conclusion: 'timed_out' });
    expect(byId.get('q-fresh')).toMatchObject({ status: 'queued', conclusion: null });
  });

  it('prune and stale tasks never throw on DAO failure', async () => {
    const broken = {
      prepare: () => {
        throw new Error('d1 down');
      },
    } as unknown as D1Queryable;
    await expect(new CheckPruneTask().run({ DB: broken } as unknown as Env)).resolves.toBeUndefined();
    await expect(new CheckStaleTask().run({ DB: broken } as unknown as Env)).resolves.toBeUndefined();
  });
});

describe('MirrorSyncTask retry', () => {
  function mirrorRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      repository_id: 'r1',
      source_url: 'https://github.com/o/r',
      interval_minutes: 60,
      enabled: 1,
      last_run_at: null,
      last_status: null,
      last_error: null,
      consecutive_failures: 0,
      created_by: 'a@x.com',
      created_at: 0,
      updated_at: 0,
      ...overrides,
    };
  }

  function mirrorStub() {
    return {
      listRefs: async () => ({ refs: [], symbolicHead: null }),
      importPack: async () => ({ importedRefs: [] as string[] }),
      isAncestor: async () => true,
      updateRefs: async () => ({ updated: [] as string[] }),
    };
  }

  it('syncs due mirrors and records ok', async () => {
    const tables = seedTables({ repos: [repoRow({ id: 'r1' })], mirrors: [mirrorRow()] });
    const env = { DB: createFakeDb(tables), REPO: { getByName: () => mirrorStub() } } as unknown as Env;
    const stub = smartHttpStub();
    try {
      await new MirrorSyncTask().run(env);
    } finally {
      stub.restore();
    }
    expect(tables.mirrors[0]).toMatchObject({ last_status: 'ok', consecutive_failures: 0 });
  });

  it('skips when no mirror is due (no network)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const tables = seedTables({ repos: [repoRow({ id: 'r1' })], mirrors: [mirrorRow({ last_run_at: now })] });
    const env = {
      DB: createFakeDb(tables),
      REPO: {
        getByName: () => {
          throw new Error('must not be called');
        },
      },
    } as unknown as Env;
    const stub = withFetchStub(() => new Response('must not be called', { status: 500 }));
    try {
      await new MirrorSyncTask().run(env);
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
    }
    expect(tables.mirrors[0]?.last_status).toBeNull();
  });

  it('records failures with retry state instead of throwing', async () => {
    const tables = seedTables({ repos: [repoRow({ id: 'r1' })], mirrors: [mirrorRow()] });
    const env = { DB: createFakeDb(tables), REPO: { getByName: () => mirrorStub() } } as unknown as Env;
    const stub = withFetchStub(() => new Response('nope', { status: 500 }));
    try {
      await new MirrorSyncTask().run(env);
    } finally {
      stub.restore();
    }
    expect(tables.mirrors[0]).toMatchObject({ last_status: 'failed', consecutive_failures: 1, enabled: 1 });
  });

  it('continues past per-mirror failures', async () => {
    const tables = seedTables({
      repos: [repoRow({ id: 'r1' }), repoRow({ id: 'r2', owner: 'alice', name: 'other' })],
      mirrors: [
        mirrorRow({ repository_id: 'r1', source_url: 'https://github.com/o/bad' }),
        mirrorRow({ repository_id: 'r2', source_url: 'https://github.com/o/good' }),
      ],
    });
    const env = { DB: createFakeDb(tables), REPO: { getByName: () => mirrorStub() } } as unknown as Env;
    const stub = withFetchStub((url) => {
      if (url.includes('/info/refs') && url.includes('/o/bad')) return new Response('nope', { status: 500 });
      if (url.includes('/info/refs')) {
        return new Response(advertisement() as unknown as BodyInit, {
          status: 200,
          headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' },
        });
      }
      return new Response(packResponse() as unknown as BodyInit, { status: 200 });
    });
    try {
      await new MirrorSyncTask().run(env);
    } finally {
      stub.restore();
    }
    const byId = new Map(tables.mirrors.map((m) => [m.repository_id, m]));
    expect(byId.get('r1')).toMatchObject({ last_status: 'failed' });
    expect(byId.get('r2')).toMatchObject({ last_status: 'ok' });
  });

  it('never throws when the due listing fails', async () => {
    const broken = {
      prepare: () => {
        throw new Error('d1 down');
      },
    } as unknown as D1Queryable;
    const env = {
      DB: broken,
      REPO: {
        getByName: () => {
          throw new Error('must not be called');
        },
      },
    } as unknown as Env;
    await expect(new MirrorSyncTask().run(env)).resolves.toBeUndefined();
  });
});

describe('transfer fetch adapter redirect budget + SSRF', () => {
  const signal = () => new AbortController().signal;

  it('follows same-origin redirects within budget', async () => {
    const stub = withFetchStub((url) => {
      if (url === 'https://github.com/o/r') return new Response(null, { status: 302, headers: { location: '/o/r2' } });
      return new Response('ok', { status: 200 });
    });
    try {
      const out = await workerFetchAdapter().get('https://github.com/o/r', {}, signal());
      expect(out.status).toBe(200);
      expect(Buffer.from(out.body).toString('utf8')).toBe('ok');
      expect(stub.calls.map((c) => c.url)).toEqual(['https://github.com/o/r', 'https://github.com/o/r2']);
    } finally {
      stub.restore();
    }
  });

  it('re-validates every hop and never fires the private request', async () => {
    const stub = withFetchStub(() => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/evil' } }));
    try {
      await expect(workerFetchAdapter().get('https://github.com/o/r', {}, signal())).rejects.toThrow();
      expect(stub.calls).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  it('rejects private initial URLs before any fetch', async () => {
    const stub = withFetchStub(() => new Response('must not fire', { status: 200 }));
    try {
      await expect(workerFetchAdapter().get('https://10.0.0.1/x.git', {}, signal())).rejects.toThrow();
      await expect(workerFetchAdapter().post('https://127.0.0.1/x.git', {}, new Uint8Array([1]), signal())).rejects.toThrow();
      expect(stub.calls).toHaveLength(0);
    } finally {
      stub.restore();
    }
  });

  it('throws once the redirect budget is exhausted', async () => {
    const stub = withFetchStub((url, init) => {
      const n = stub.calls.length;
      void init;
      return new Response(null, { status: 302, headers: { location: `https://github.com/hop-${n}` } });
    });
    try {
      await expect(workerFetchAdapter().get('https://github.com/o/r', {}, signal())).rejects.toThrow(/too many redirects/);
      expect(stub.calls.length).toBeGreaterThanOrEqual(4);
    } finally {
      stub.restore();
    }
  });

  it('converts POST to GET on 301 redirect hops', async () => {
    const stub = withFetchStub((url) => {
      if (url === 'https://github.com/a') return new Response(null, { status: 301, headers: { location: '/b' } });
      return new Response('done', { status: 200 });
    });
    try {
      const out = await workerFetchAdapter().post('https://github.com/a', {}, new Uint8Array([1, 2]), signal());
      expect(out.status).toBe(200);
      expect(stub.calls).toHaveLength(2);
      expect(stub.calls[1]?.url).toBe('https://github.com/b');
      expect(stub.calls[1]?.init?.method).toBeUndefined();
      expect('body' in (stub.calls[1]?.init ?? {})).toBe(false);
    } finally {
      stub.restore();
    }
  });
});
