import { describe, expect, it, vi } from 'vitest';
import { RepoLifecycle } from '@edge-git/background/RepoLifecycle';
import { RepoWorker } from '@edge-git/background/RepoWorker';
import { CheckRunnerWorker } from '@edge-git/background/checks/CheckRunnerWorker';
import { RepoVacuumTask, VACUUM_GRACE_SECONDS } from '@edge-git/background/scheduled/RepoVacuumTask';
import { CRON_TASK_FACTORIES } from '@edge-git/background/scheduled/TaskRegistry';
import { DeletedRepoDoDAO } from '@edge-git/backend-data/dao';
import { CheckRunDAO } from '@edge-git/backend-data/dao';
import { NumberingDAO } from '@edge-git/backend-data/dao';
import { SearchDAO } from '@edge-git/backend-data/dao';
import { KvCache } from '@edge-git/backend-runtime/kv';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { TimestampUtil, repoDoKeyForFullName } from '@edge-git/shared/utils';
import { enqueueRepoVacuum } from '@/workers/routes/RepoVacuum';

vi.mock('@edge-git/git-service', () => ({ setDofsDeviceSize: vi.fn(), createDofsFs: vi.fn() }));

interface VacuumTables {
  tombs: Array<Record<string, unknown>>;
  repos: Array<Record<string, unknown>>;
  checks: Array<Record<string, unknown>>;
  counters: Array<Record<string, unknown>>;
  codeIndex: Array<Record<string, unknown>>;
}

function seedTables(partial: Partial<VacuumTables> = {}): VacuumTables {
  return { tombs: [], repos: [], checks: [], counters: [], codeIndex: [], ...partial };
}

function tombRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { do_key: 'alice/demo', full_name: 'alice/demo', repo_id: 'r1', deleted_at: 1000, attempts: 0, ...overrides };
}

function createFakeDb(tables: VacuumTables): D1Queryable {
  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM repositories WHERE owner_ci = ? AND name_ci = ?')) {
          const row = tables.repos.find((r) => r.owner_ci === params[0] && r.name_ci === params[1]) ?? null;
          return Promise.resolve(row as T | null);
        }
        if (q.includes('deleted_repo_dos SET attempts = attempts + 1')) {
          const row = tables.tombs.find((t) => t.do_key === params[0]);
          if (!row) return Promise.resolve(null);
          row.attempts = (row.attempts as number) + 1;
          return Promise.resolve({ attempts: row.attempts } as unknown as T);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM deleted_repo_dos WHERE deleted_at <= ?')) {
          const cutoff = params[0] as number;
          const limit = params[1] as number;
          const rows = tables.tombs
            .filter((t) => (t.deleted_at as number) <= cutoff)
            .sort((a, b) => (a.deleted_at as number) - (b.deleted_at as number))
            .slice(0, limit);
          return Promise.resolve({ results: rows as T[] });
        }
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta: { changes: number } }> {
        if (q.startsWith('INSERT INTO deleted_repo_dos')) {
          const [do_key, full_name, repo_id, deleted_at] = params as [string, string, string, number];
          const existing = tables.tombs.find((t) => t.do_key === do_key);
          if (existing) {
            Object.assign(existing, { full_name, repo_id, deleted_at, attempts: 0 });
          } else {
            tables.tombs.push({ do_key, full_name, repo_id, deleted_at, attempts: 0 });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM deleted_repo_dos WHERE do_key = ?')) {
          const before = tables.tombs.length;
          tables.tombs = tables.tombs.filter((t) => t.do_key !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: before - tables.tombs.length } });
        }
        if (q.startsWith('DELETE FROM check_runs WHERE repository_id = ?')) {
          tables.checks = tables.checks.filter((r) => r.repository_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repo_number_counters WHERE repository_id = ?')) {
          tables.counters = tables.counters.filter((r) => r.repository_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM code_index WHERE repo_id = ?')) {
          tables.codeIndex = tables.codeIndex.filter((r) => r.repo_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      },
    };
  }
  return { prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) } as unknown as D1Queryable;
}

function fakeCache() {
  const kv = new Map<string, string>();
  const deleted: string[] = [];
  return {
    store: kv,
    deleted,
    ns: {
      get: (k: string) => Promise.resolve(kv.get(k) ?? null),
      put: (k: string, v: string) => {
        kv.set(k, v);
        return Promise.resolve();
      },
      delete: (k: string) => {
        kv.delete(k);
        deleted.push(k);
        return Promise.resolve();
      },
      list: ({ prefix, limit }: { prefix: string; limit?: number }) => {
        const keys = [...kv.keys()]
          .filter((k) => k.startsWith(prefix))
          .slice(0, limit ?? 1000)
          .map((name) => ({ name }));
        return Promise.resolve({ keys, list_complete: true });
      },
    },
  };
}

function fakeDoState() {
  const map = new Map<string, unknown>();
  return {
    map,
    state: {
      storage: {
        get: (key: string) => Promise.resolve(map.get(key) ?? null),
        put: (key: string, value: unknown) => {
          map.set(key, value);
          return Promise.resolve();
        },
        delete: (key: string) => {
          map.delete(key);
          return Promise.resolve(1);
        },
        deleteAll: () => {
          map.clear();
          return Promise.resolve();
        },
      },
    } as unknown as DurableObjectState,
  };
}

describe('DeletedRepoDoDAO tombstones', () => {
  it('enqueues, lists due past the grace cutoff, and removes', async () => {
    const tables = seedTables();
    const dao = new DeletedRepoDoDAO(createFakeDb(tables));
    await dao.enqueue('alice/demo', 'alice/demo', 'r1', 1000);
    await dao.enqueue('bob/other', 'bob/other', 'r2', 5000);
    // Conflict re-enqueue resets attempts and refreshes the payload.
    tables.tombs[0]!.attempts = 4;
    await dao.enqueue('alice/demo', 'Alice/Demo', 'r1', 6000);
    expect(tables.tombs.find((t) => t.do_key === 'alice/demo')).toMatchObject({
      full_name: 'Alice/Demo',
      deleted_at: 6000,
      attempts: 0,
    });
    const due = await dao.listDue(5500, 10);
    expect(due.map((t) => t.do_key)).toEqual(['bob/other']);
    await dao.remove('bob/other');
    expect(tables.tombs.map((t) => t.do_key)).toEqual(['alice/demo']);
  });

  it('recordAttempt counts up poison retries', async () => {
    const tables = seedTables({ tombs: [tombRow()] });
    const dao = new DeletedRepoDoDAO(createFakeDb(tables));
    await expect(dao.recordAttempt('alice/demo')).resolves.toBe(1);
    await expect(dao.recordAttempt('alice/demo')).resolves.toBe(2);
    await expect(dao.recordAttempt('missing')).resolves.toBe(0);
  });
});

describe('per-repo deleteByRepo purges', () => {
  it('check runs, number counters, and code index clear by repo', async () => {
    const tables = seedTables({
      checks: [{ repository_id: 'r1' }, { repository_id: 'r2' }],
      counters: [{ repository_id: 'r1' }],
      codeIndex: [{ repo_id: 'r1' }, { repo_id: 'r2' }],
    });
    const db = createFakeDb(tables);
    await new CheckRunDAO(db).deleteByRepo('r1');
    await new NumberingDAO(db).deleteByRepo('r1');
    await new SearchDAO(db).deleteByRepo('r1');
    expect(tables.checks.map((r) => r.repository_id)).toEqual(['r2']);
    expect(tables.counters).toEqual([]);
    expect(tables.codeIndex.map((r) => r.repo_id)).toEqual(['r2']);
  });
});

describe('RepoLifecycle.vacuum', () => {
  function makeLifecycle(boundName: string | null) {
    const { state } = fakeDoState();
    const deletedKeys: string[] = [];
    const storage = {
      get: vi.fn(async () => boundName),
      delete: vi.fn(async (key: string) => void deletedKeys.push(key)),
      deleteAll: vi.fn(async () => undefined),
    };
    const git = { initRepo: vi.fn(async () => undefined), clearCache: vi.fn() };
    const lifecycle = new RepoLifecycle(
      { storage } as never,
      {} as never,
      {} as never,
      {} as never,
      git as never,
      {} as never,
      () => undefined,
      async () => undefined,
    );
    return { lifecycle, storage, git, state };
  }

  it('aborts when the name binding is live (recreated repo wins)', async () => {
    const { lifecycle, storage } = makeLifecycle('alice/demo');
    await expect(lifecycle.vacuum()).resolves.toEqual({ vacuumed: false, reason: 'name-live' });
    expect(storage.deleteAll).not.toHaveBeenCalled();
  });

  it('deletes all storage and re-bootstraps the dofs schema when the name is free', async () => {
    const { lifecycle, storage, git } = makeLifecycle(null);
    const { createDofsFs } = await import('@edge-git/git-service');
    await expect(lifecycle.vacuum()).resolves.toEqual({ vacuumed: true, reason: 'reclaimed' });
    expect(storage.deleteAll).toHaveBeenCalledTimes(1);
    expect(createDofsFs).toHaveBeenCalled();
    expect(git.clearCache).toHaveBeenCalled();
  });

  it('RepoWorker.vacuum delegates and clears the cached name only on reclaim', async () => {
    const vacuum = vi.fn(async () => ({ vacuumed: true, reason: 'reclaimed' }));
    const worker = Object.create(RepoWorker.prototype) as InstanceType<typeof RepoWorker>;
    Object.assign(worker, { lifecycle: { vacuum }, fullNameValue: undefined });
    await expect(worker.vacuum()).resolves.toEqual({ vacuumed: true, reason: 'reclaimed' });
    expect(vacuum).toHaveBeenCalledTimes(1);
  });
});

describe('CheckRunnerWorker.purgeRepo', () => {
  function makeWorker(pending: Array<Record<string, unknown>>) {
    const map = new Map<string, unknown>([['pending', pending]]);
    const state = {
      storage: {
        get: (key: string) => Promise.resolve(map.get(key) ?? null),
        put: (key: string, value: unknown) => {
          map.set(key, value);
          return Promise.resolve();
        },
      },
    } as unknown as DurableObjectState;
    return { worker: new CheckRunnerWorker(state, {} as Env), map };
  }

  it('drops only the deleted repo queue items', async () => {
    const { worker, map } = makeWorker([
      { repositoryId: 'r1', contexts: ['a'] },
      { repositoryId: 'r2', contexts: ['b'] },
    ]);
    await expect(worker.purgeRepo('r1')).resolves.toEqual({ removed: 1 });
    expect(map.get('pending')).toEqual([{ repositoryId: 'r2', contexts: ['b'] }]);
    await expect(worker.purgeRepo('r9')).resolves.toEqual({ removed: 0 });
  });

  it('tolerates a missing queue', async () => {
    const { worker } = makeWorker([]);
    await expect(worker.purgeRepo('r1')).resolves.toEqual({ removed: 0 });
  });
});

describe('RepoVacuumTask background reclaim', () => {
  const FULL = 'alice/demo';

  function taskEnv(
    tables: VacuumTables,
    opts: {
      repos?: Array<Record<string, unknown>>;
      vacuumImpl?: (key: string) => Promise<{ vacuumed: boolean; reason: string }>;
      vacuumKeys?: string[];
      checkKeys?: string[];
      purgedIds?: string[];
      cache?: ReturnType<typeof fakeCache>;
    } = {},
  ) {
    tables.repos = opts.repos ?? [];
    const vacuumKeys = opts.vacuumKeys ?? [];
    const checkKeys = opts.checkKeys ?? [];
    const purgedIds = opts.purgedIds ?? [];
    const cache = opts.cache ?? fakeCache();
    const vacuumImpl = opts.vacuumImpl ?? (async () => ({ vacuumed: true, reason: 'reclaimed' }));
    const env = {
      DB: createFakeDb(tables),
      CACHE: cache.ns,
      REPO: {
        getByName: (key: string) => {
          vacuumKeys.push(key);
          return { vacuum: () => vacuumImpl(key) };
        },
      },
      CHECK_RUNNER: {
        getByName: (key: string) => {
          checkKeys.push(key);
          return { purgeRepo: (id: string) => void purgedIds.push(id) };
        },
      },
    } as unknown as Env;
    return { env, cache, vacuumKeys, checkKeys, purgedIds };
  }

  function oldTomb(overrides: Record<string, unknown> = {}) {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    return tombRow({ deleted_at: now - VACUUM_GRACE_SECONDS - 60, ...overrides });
  }

  it('is registered as a phase-2 cron task', () => {
    const def = CRON_TASK_FACTORIES.find((d) => d.name === 'RepoVacuumTask');
    expect(def?.phase).toBe(2);
    expect(def?.make().name).toBe('RepoVacuumTask');
  });

  it('vacuums free names: REPO deleteAll, check purge, KV purge, tombstone gone', async () => {
    const tables = seedTables({ tombs: [oldTomb()] });
    const { env, cache, vacuumKeys, checkKeys, purgedIds } = taskEnv(tables);
    const key = repoDoKeyForFullName(FULL);
    const kv = new KvCache(cache.ns as never);
    await kv.putJson('refs', [key, 'snapshot'], { refs: [] });
    await kv.putJson('readmodel', [key, 'branches', 'empty', 'abc'], { branches: [] });
    await new RepoVacuumTask().run(env);
    // Direct namespace routing by stored do_key — never getRepoStub (which
    // would re-persist fullName and trip the vacuum guard).
    expect(vacuumKeys).toEqual(['alice/demo']);
    expect(checkKeys).toEqual(['alice/demo']);
    expect(purgedIds).toEqual(['r1']);
    expect(await kv.getJson('refs', [key, 'snapshot'])).toBeNull();
    expect(await kv.getJson('readmodel', [key, 'branches', 'empty', 'abc'])).toBeNull();
    expect(tables.tombs).toEqual([]);
  });

  it('skips live (recreated) names but still purges their stale check queue', async () => {
    const tables = seedTables({ tombs: [oldTomb()] });
    const live = { id: 'r-new', owner: 'alice', name: 'demo', owner_ci: 'alice', name_ci: 'demo' };
    const { env, vacuumKeys, purgedIds } = taskEnv(tables, { repos: [live] });
    await new RepoVacuumTask().run(env);
    expect(vacuumKeys).toEqual([]);
    expect(purgedIds).toEqual(['r1']);
    expect(tables.tombs).toEqual([]);
  });

  it('leaves young tombstones for a later tick', async () => {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const tables = seedTables({ tombs: [tombRow({ deleted_at: now })] });
    const { env, vacuumKeys } = taskEnv(tables);
    await new RepoVacuumTask().run(env);
    expect(vacuumKeys).toEqual([]);
    expect(tables.tombs).toHaveLength(1);
  });

  it('keeps failed tombstones with an attempt counted, drops poison ones', async () => {
    const tables = seedTables({ tombs: [oldTomb({ do_key: 'flaky/x', full_name: 'flaky/x' })] });
    const flaky = taskEnv(tables, { vacuumImpl: async () => Promise.reject(new Error('DO busy')) });
    await new RepoVacuumTask().run(flaky.env);
    expect(tables.tombs).toHaveLength(1);
    expect(tables.tombs[0]).toMatchObject({ do_key: 'flaky/x', attempts: 1 });

    tables.tombs[0]!.attempts = 9;
    await new RepoVacuumTask().run(flaky.env);
    expect(tables.tombs).toEqual([]);
  });
});

describe('vacuum tombstone enqueue paths', () => {
  it('enqueueRepoVacuum persists a canonical-key tombstone via composition', async () => {
    const tables = seedTables();
    const env = { DB: createFakeDb(tables) } as unknown as Env;
    await enqueueRepoVacuum(env, 'Alice/Demo', 'r1');
    expect(tables.tombs).toHaveLength(1);
    expect(tables.tombs[0]).toMatchObject({ do_key: 'alice/demo', full_name: 'Alice/Demo', repo_id: 'r1' });
    // Composition wiring exposes the DAO token the helper resolves.
    const scope = createRequestScope(env as never);
    const dao = await scope.get(Tokens.DeletedRepoDoDAO)();
    expect(dao).toBeInstanceOf(DeletedRepoDoDAO);
  });

  it('RepoService.deleteRepo enqueues a vacuum tombstone alongside the D1 delete', async () => {
    const tables = seedTables();
    const repo = { id: 'r1', owner: 'alice', name: 'demo', owner_email: 'a@x.com', is_private: 0 };
    const deleted: string[] = [];
    const ok = () => Promise.resolve({ deleteByRepo: () => Promise.resolve() });
    const svc = new RepoService({ DB: createFakeDb(tables) } as never, {
      repositoryDAO: async () =>
        ({ getByOwnerAndName: async () => repo, deleteById: async (id: string) => void deleted.push(id) }) as never,
      permissionService: async () => ({ getRole: async () => 'admin' }) as never,
      issueDAO: ok,
      pullRequestDAO: ok,
      pullThreadDAO: ok,
      branchProtectionDAO: ok,
      repoCollaboratorDAO: ok,
      starDAO: ok,
      watchDAO: ok,
      eventDAO: ok,
      notificationDAO: ok,
      releaseDAO: ok,
      projectDAO: ok,
      discussionDAO: ok,
      wikiDAO: ok,
      importDAO: ok,
      mirrorDAO: ok,
      deployKeyDAO: ok,
      tokenGrantDAO: ok,
      securitySettingsDAO: ok,
      collaborationDAO: ok,
      webhookDAO: ok,
      webhookDeliveryDAO: ok,
      auditLogDAO: ok,
      teamGrantDAO: ok,
      checkRunDAO: ok,
    } as never);
    await expect(svc.deleteRepo('alice', 'demo', 'a@x.com')).resolves.toEqual({ id: 'r1' });
    expect(deleted).toEqual(['r1']);
    expect(tables.tombs).toHaveLength(1);
    expect(tables.tombs[0]).toMatchObject({ do_key: 'alice/demo', repo_id: 'r1' });
  });
});
