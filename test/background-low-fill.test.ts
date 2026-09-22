import { describe, expect, it, vi } from 'vitest';

// FetchHandler value-imports PackLimitError from the git-service barrel
// (dofs -> cloudflare:* unavailable in node pool). RepoWorker also pulls
// createDofsFs/GitService/IsoGitFs via its factory — stub the barrel.
vi.mock('@edge-git/git-service', () => {
  class PackLimitError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PackLimitError';
    }
  }
  return {
    PackLimitError,
    setDofsDeviceSize: vi.fn(),
    createDofsFs: vi.fn(() => ({})),
    GitService: class {},
    IsoGitFs: class {},
  };
});

import { PktLine } from '@edge-git/git-protocol';
import { FetchHandler } from '@edge-git/background/FetchHandler';
import { PackLimitError } from '@edge-git/git-service';
import { ReadModelService } from '@edge-git/background/ReadModelService';
import { RealtimeWorker } from '@edge-git/background/realtime/RealtimeWorker';
import { CheckRunnerWorker } from '@edge-git/background/checks/CheckRunnerWorker';
import { RepoWorker } from '@edge-git/background/RepoWorker';
import type { D1Queryable } from '@edge-git/backend-data/utils';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_C = 'c'.repeat(40);
const OID_ZERO = '0'.repeat(40);

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------
function encodeCommand(command: string, args: string[]): Uint8Array {
  const lines = [
    PktLine.encode(`command=${command}\n`),
    PktLine.encodeDelim(),
    ...args.map((a) => PktLine.encode(`${a}\n`)),
    PktLine.encodeFlush(),
  ];
  return PktLine.mergeLines(lines);
}

function textBlob(text: string): { contentBase64: string; isBinary: boolean } {
  return { contentBase64: Buffer.from(text, 'utf8').toString('base64'), isBinary: false };
}

function fakeFetchGit(overrides: Record<string, unknown> = {}) {
  return {
    ensureFreshCache: vi.fn(),
    listRefs: vi.fn().mockResolvedValue({ refs: [], symbolicHead: null }),
    findCommonCommits: vi.fn().mockResolvedValue([]),
    resolveRef: vi.fn().mockImplementation((ref: string) => Promise.resolve(ref)),
    collectObjectsForPack: vi.fn().mockResolvedValue({ oids: [], shallow: [] }),
    packObjects: vi.fn().mockResolvedValue(new Uint8Array(0)),
    listTags: vi.fn().mockResolvedValue([]),
    peelTag: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as never;
}

const FETCH_LIMITS = {
  maxWants: 64,
  maxHaves: 512,
  maxObjects: 10,
  maxPackBytes: 1024 * 1024,
  maxFetchBodyBytes: 1024 * 1024,
};

// --- CheckRunnerWorker D1 fake (mirrors check-runner-hardening.test.ts) ---
function fakeCheckState(map: Map<string, unknown>) {
  return {
    storage: {
      get: (key: string) => Promise.resolve(map.get(key) ?? undefined),
      put: (key: string, value: unknown) => {
        map.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => {
        map.delete(key);
        return Promise.resolve();
      },
      setAlarm: () => Promise.resolve(),
    },
  } as unknown as DurableObjectState;
}

function createCheckDb() {
  const checkRuns: Array<Record<string, unknown>> = [];
  const repos = [{ id: 'repo-1', owner: 'alice', name: 'demo', owner_email: 'a@x.com', updated_at: 1 }];
  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.startsWith('SELECT * FROM repositories WHERE id = ?')) {
          return Promise.resolve((repos.find((r) => r.id === params[0]) ?? null) as T | null);
        }
        if (q.startsWith('SELECT * FROM check_runs WHERE repository_id = ? AND head_sha = ? AND context = ?')) {
          const row = checkRuns.find((r) => r.repository_id === params[0] && r.head_sha === params[1] && r.context === params[2]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.startsWith('SELECT * FROM check_runs WHERE id = ? AND repository_id = ?')) {
          const row = checkRuns.find((r) => r.id === params[0] && r.repository_id === params[1]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.startsWith('SELECT COUNT(*) AS n FROM check_runs')) {
          const n = checkRuns.filter((r) => r.repository_id === params[0] && r.head_sha === params[1]).length;
          return Promise.resolve({ n } as unknown as T);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
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
          checkRuns.push({
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
          const row = checkRuns.find((r) => r.id === id && r.repository_id === repository_id);
          if (row) {
            Object.assign(row, { status, conclusion, details_url, output_title, output_summary, updated_at, completed_at });
            return Promise.resolve({ success: true, meta: { changes: 1 } });
          }
          return Promise.resolve({ success: true, meta: { changes: 0 } });
        }
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      },
    };
  }
  const db = { prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) } as unknown as D1Queryable;
  return { db, checkRuns };
}

function checkEnv(db: D1Queryable, stub: unknown, extra: Record<string, string> = {}) {
  return { DB: db, REPO: { getByName: () => stub }, ...extra } as unknown as Env;
}

function defaultRepoStub(overrides: Record<string, unknown> = {}) {
  return {
    listAllFiles: async () => [{ path: 'README.md', oid: OID_A }],
    getBlob: async () => textBlob('# hello'),
    getCommitDiff: async () => ({ files: [] }),
    ...overrides,
  };
}

// --- ReadModelService fake git ---
function makeReadGit(overrides: Record<string, unknown> = {}) {
  return {
    listBranches: vi.fn(async () => ['main', 'feat']),
    currentBranch: vi.fn(async () => 'main'),
    resolveRef: vi.fn(async (ref?: string) => (ref === 'missing' ? null : OID_A)),
    getTree: vi.fn(async () => []),
    getLog: vi.fn(async () => []),
    getLastCommit: vi.fn(async () => ({ oid: OID_A })),
    listTags: vi.fn(async () => []),
    peelTag: vi.fn(async () => null),
    getBlob: vi.fn(async () => null),
    getCommit: vi.fn(async () => ({ oid: OID_A })),
    getCommitDiff: vi.fn(async () => ({ files: [] })),
    getCompareDiff: vi.fn(async () => ({ files: [] })),
    getMergePreview: vi.fn(async () => ({ ok: true })),
    getMergePreviewByOids: vi.fn(async () => ({ ok: true })),
    findMergeBase: vi.fn(async () => OID_A),
    getFileStateChanges: vi.fn(async () => []),
    getBlame: vi.fn(async () => ({ lines: [] })),
    ...overrides,
  } as unknown as Record<string, ReturnType<typeof vi.fn>> & Record<string, unknown>;
}

// --- RealtimeWorker helpers (mirrors realtime-worker.test.ts) ---
interface FakeSocket {
  sent: string[];
  closed: { code: number; reason: string } | null;
  attachment: unknown;
  failSend: boolean;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(data: unknown): void;
  deserializeAttachment(): unknown;
}

function makeSocket(attachment: unknown = null): FakeSocket {
  return {
    sent: [],
    closed: null,
    attachment,
    failSend: false,
    send(payload: string) {
      if (this.failSend) throw new Error('dead socket');
      this.sent.push(payload);
    },
    close(code = 1000, reason = '') {
      this.closed = { code, reason };
    },
    serializeAttachment(data: unknown) {
      this.attachment = data;
    },
    deserializeAttachment() {
      return this.attachment;
    },
  };
}

function makeRealtimeCtx(name: string) {
  const store = new Map<string, unknown>();
  const entries: Array<{ ws: FakeSocket; tags: string[] }> = [];
  const ctx = {
    id: { name },
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      setAlarm: async () => undefined,
    },
    acceptWebSocket: (ws: FakeSocket, tags: string[] = []) => {
      entries.push({ ws, tags });
    },
    getWebSockets: (tag?: string) =>
      entries.filter((entry) => entry.ws.closed === null && (tag === undefined || entry.tags.includes(tag))).map((entry) => entry.ws),
  };
  return { ctx, store, entries };
}

function makeRealtimeWorker(name: string, env: Record<string, string> = {}) {
  const { ctx, store, entries } = makeRealtimeCtx(name);
  const worker = new RealtimeWorker(ctx as unknown as DurableObjectState, env as unknown as Env);
  return { worker, ctx, store, entries };
}

// --- RepoWorker helper ---
function makeRepoWorker(parts: Record<string, unknown>) {
  const worker = Object.create(RepoWorker.prototype) as InstanceType<typeof RepoWorker>;
  Object.assign(worker, parts);
  return worker;
}

function repoStorage(initial: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(initial));
  return {
    map,
    get: vi.fn(async (key: string) => map.get(key) ?? null),
    put: vi.fn(async (key: string, value: unknown) => {
      map.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      map.delete(key);
    }),
  };
}

// ---------------------------------------------------------------------------
// CheckRunnerWorker: queue / claim / stale / timeout paths
// ---------------------------------------------------------------------------
describe('background-low-fill CheckRunnerWorker queue/claim paths', () => {
  it('fetch rejects malformed enqueue with 400 and unknown paths with 404', async () => {
    const { db } = createCheckDb();
    const worker = new CheckRunnerWorker(fakeCheckState(new Map()), checkEnv(db, defaultRepoStub()));
    const bad = await worker.fetch(
      new Request('https://x/enqueue', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
    );
    expect(bad.status).toBe(400);
    const getOnEnqueue = await worker.fetch(new Request('https://x/enqueue', { method: 'GET' }));
    expect(getOnEnqueue.status).toBe(404);
    const unknown = await worker.fetch(new Request('https://x/nope'));
    expect(unknown.status).toBe(404);
  });

  it('enqueue trims, dedupes, lowercases headSha and caps at 50 contexts', async () => {
    const { db } = createCheckDb();
    const map = new Map<string, unknown>();
    const worker = new CheckRunnerWorker(fakeCheckState(map), checkEnv(db, defaultRepoStub()));
    const many = Array.from({ length: 60 }, (_, i) => `  ctx-${i} `);
    const queued = await worker.enqueueChecks({
      repositoryId: 'repo-1',
      headSha: OID_A.toUpperCase(),
      contexts: [' secret-scan ', 'secret-scan', '', ...many],
      actorEmail: 'a@x.com',
    });
    expect(queued.queued).toBe(50);
    const pending = map.get('pending') as Array<{ headSha: string; contexts: string[] }>;
    expect(pending).toHaveLength(1);
    expect(pending[0].headSha).toBe(OID_A);
    expect(pending[0].contexts).toHaveLength(50);
    expect(pending[0].contexts[0]).toBe('secret-scan');
    expect(await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: OID_A, contexts: ['   '], actorEmail: 'a@x.com' })).toEqual({
      queued: 0,
    });
  });

  it('enqueue replaces pending for same repo+sha but keeps other shas', async () => {
    const { db } = createCheckDb();
    const map = new Map<string, unknown>();
    const worker = new CheckRunnerWorker(fakeCheckState(map), checkEnv(db, defaultRepoStub()));
    await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: OID_A, contexts: ['secret-scan'], actorEmail: 'a@x.com' });
    await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: OID_B, contexts: ['diff-limit'], actorEmail: 'a@x.com' });
    expect(map.get('pending') as unknown[]).toHaveLength(2);
    await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: OID_A, contexts: ['codeowners-exists'], actorEmail: 'a@x.com' });
    const pending = map.get('pending') as Array<{ headSha: string; contexts: string[] }>;
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.headSha).sort()).toEqual([OID_A, OID_B].sort());
    expect(pending.find((p) => p.headSha === OID_A)?.contexts).toEqual(['codeowners-exists']);
  });

  it('alarm is a no-op on empty pending', async () => {
    const { db } = createCheckDb();
    const map = new Map<string, unknown>();
    const worker = new CheckRunnerWorker(fakeCheckState(map), checkEnv(db, defaultRepoStub()));
    await worker.alarm();
    expect(map.get('pending')).toBeUndefined();
  });

  it('alarm completes secret-scan success when no secrets present', async () => {
    const { db, checkRuns } = createCheckDb();
    const map = new Map<string, unknown>();
    const worker = new CheckRunnerWorker(fakeCheckState(map), checkEnv(db, defaultRepoStub()));
    await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: OID_A, contexts: ['secret-scan'], actorEmail: 'a@x.com' });
    await worker.alarm();
    expect(checkRuns).toHaveLength(1);
    expect(checkRuns[0]).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(map.get('pending')).toEqual([]);
  });

  it('alarm marks secret-scan failure when a secret pattern is present', async () => {
    const { db, checkRuns } = createCheckDb();
    const stub = defaultRepoStub({
      listAllFiles: async () => [{ path: 'src/a.ts', oid: OID_A }],
      getBlob: async () => textBlob('key = "AKIAIOSFODNN7EXAMPLE"'),
    });
    const worker = new CheckRunnerWorker(fakeCheckState(new Map()), checkEnv(db, stub));
    await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: OID_A, contexts: ['secret-scan'], actorEmail: 'a@x.com' });
    await worker.alarm();
    expect(checkRuns).toHaveLength(1);
    expect(checkRuns[0]).toMatchObject({ status: 'completed', conclusion: 'failure' });
  });

  it('alarm handles binary blobs by skipping them in secret-scan', async () => {
    const { db, checkRuns } = createCheckDb();
    const stub = defaultRepoStub({
      listAllFiles: async () => [{ path: 'bin/a.bin', oid: OID_A }],
      getBlob: async () => ({ contentBase64: Buffer.from([0, 1, 2]).toString('base64'), isBinary: true }),
    });
    const worker = new CheckRunnerWorker(fakeCheckState(new Map()), checkEnv(db, stub));
    await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: OID_A, contexts: ['secret-scan'], actorEmail: 'a@x.com' });
    await worker.alarm();
    expect(checkRuns).toHaveLength(1);
    expect(checkRuns[0]).toMatchObject({ status: 'completed', conclusion: 'success' });
  });

  it('alarm runs diff-limit failure when file count exceeds the cap', async () => {
    const { db, checkRuns } = createCheckDb();
    const stub = defaultRepoStub({ getCommitDiff: async () => ({ files: [{}, {}, {}, {}, {}] }) });
    const worker = new CheckRunnerWorker(fakeCheckState(new Map()), checkEnv(db, stub, { MAX_MERGE_DIFF_FILES: '2' }));
    await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: OID_A, contexts: ['diff-limit'], actorEmail: 'a@x.com' });
    await worker.alarm();
    expect(checkRuns).toHaveLength(1);
    expect(checkRuns[0]).toMatchObject({ status: 'completed', conclusion: 'failure' });
  });

  it('alarm runs codeowners-exists neutral when missing and success when present', async () => {
    const { db: db1, checkRuns: runsMissing } = createCheckDb();
    const missing = new CheckRunnerWorker(fakeCheckState(new Map()), checkEnv(db1, defaultRepoStub({ getBlob: async () => null })));
    await missing.enqueueChecks({ repositoryId: 'repo-1', headSha: OID_A, contexts: ['codeowners-exists'], actorEmail: 'a@x.com' });
    await missing.alarm();
    expect(runsMissing).toHaveLength(1);
    expect(runsMissing[0]).toMatchObject({ status: 'completed', conclusion: 'neutral' });

    const { db: db2, checkRuns: runsPresent } = createCheckDb();
    const present = new CheckRunnerWorker(
      fakeCheckState(new Map()),
      checkEnv(db2, defaultRepoStub({ getBlob: async () => textBlob('* @alice\n') })),
    );
    await present.enqueueChecks({ repositoryId: 'repo-1', headSha: OID_A, contexts: ['codeowners-exists'], actorEmail: 'a@x.com' });
    await present.alarm();
    expect(runsPresent).toHaveLength(1);
    expect(runsPresent[0]).toMatchObject({ status: 'completed', conclusion: 'success' });
  });

  it('alarm runs required-files failure when patterns are missing', async () => {
    const { db, checkRuns } = createCheckDb();
    const stub = defaultRepoStub({ listAllFiles: async () => [{ path: 'src/a.ts', oid: OID_A }] });
    const worker = new CheckRunnerWorker(fakeCheckState(new Map()), checkEnv(db, stub));
    await worker.enqueueChecks({
      repositoryId: 'repo-1',
      headSha: OID_A,
      contexts: ['required-files:README.md,LICENSE'],
      actorEmail: 'a@x.com',
    });
    await worker.alarm();
    expect(checkRuns).toHaveLength(1);
    expect(checkRuns[0]).toMatchObject({ status: 'completed', conclusion: 'failure' });
  });

  it('alarm leaves custom contexts queued when no definition file exists', async () => {
    const { db, checkRuns } = createCheckDb();
    const stub = defaultRepoStub({ listAllFiles: async () => [], getBlob: async () => null });
    const worker = new CheckRunnerWorker(fakeCheckState(new Map()), checkEnv(db, stub));
    await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: OID_B, contexts: ['ci/external'], actorEmail: 'a@x.com' });
    await worker.alarm();
    expect(checkRuns).toHaveLength(0);
  });

  it('alarm marks action_required for an invalid check definition', async () => {
    const { db, checkRuns } = createCheckDb();
    const stub = defaultRepoStub({ getBlob: async () => textBlob('not-json{{{') });
    // getBlob is used for both checks.json load (invalid) — definition error path
    const worker = new CheckRunnerWorker(fakeCheckState(new Map()), checkEnv(db, stub));
    await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: OID_A, contexts: ['ci/custom'], actorEmail: 'a@x.com' });
    await worker.alarm();
    expect(checkRuns).toHaveLength(1);
    expect(checkRuns[0]).toMatchObject({ status: 'completed', conclusion: 'action_required' });
  });

  it('alarm marks action_required when the custom script is unavailable', async () => {
    const { db, checkRuns } = createCheckDb();
    const definition = JSON.stringify({ checks: [{ context: 'ci/custom', script: '.edgegit/checks/custom.js' }] });
    const stub = {
      listAllFiles: async () => [{ path: '.edgegit/checks.json', oid: OID_A }],
      getBlob: async (args: { filepath: string }) => (args.filepath === '.edgegit/checks.json' ? textBlob(definition) : null),
      getCommitDiff: async () => ({ files: [] }),
    };
    const worker = new CheckRunnerWorker(
      fakeCheckState(new Map()),
      checkEnv(db, stub, { CHECK_CUSTOMJS_ENABLED: 'true', CHECK_CUSTOMJS_MAX_SCRIPT_BYTES: '65536' }),
    );
    await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: OID_A, contexts: ['ci/custom'], actorEmail: 'a@x.com' });
    await worker.alarm();
    expect(checkRuns).toHaveLength(1);
    expect(checkRuns[0]).toMatchObject({ status: 'completed', conclusion: 'action_required' });
  });

  it('alarm requeues on stale throw with attempts+1 and drops after max attempts', async () => {
    const { db } = createCheckDb();
    const map = new Map<string, unknown>();
    const alarms: number[] = [];
    const state = {
      storage: {
        get: (key: string) => Promise.resolve(map.get(key) ?? undefined),
        put: (key: string, value: unknown) => {
          map.set(key, value);
          return Promise.resolve();
        },
        setAlarm: (ts: number) => {
          alarms.push(ts);
          return Promise.resolve();
        },
      },
    } as unknown as DurableObjectState;
    const throwingRepo = {
      listAllFiles: async () => {
        throw new Error('stale read');
      },
      getBlob: async () => {
        throw new Error('stale read');
      },
      getCommitDiff: async () => {
        throw new Error('stale read');
      },
    };
    // Force processItem to throw via REPO.getByName throwing
    const env = {
      DB: db,
      REPO: {
        getByName: () => {
          throw new Error('stub gone');
        },
      },
    } as unknown as Env;
    const worker = new CheckRunnerWorker(state, env);
    map.set('pending', [{ repositoryId: 'repo-1', headSha: OID_A, contexts: ['secret-scan'], actorEmail: 'a@x.com', attempts: 0 }]);
    await worker.alarm();
    const pending = map.get('pending') as Array<{ attempts: number }>;
    expect(pending).toHaveLength(1);
    expect(pending[0].attempts).toBe(1);
    expect(alarms.length).toBeGreaterThan(0);

    // At max attempts the item is dropped, not requeued
    map.set('pending', [{ repositoryId: 'repo-1', headSha: OID_A, contexts: ['secret-scan'], actorEmail: 'a@x.com', attempts: 3 }]);
    const before = alarms.length;
    await worker.alarm();
    expect(map.get('pending') as unknown[]).toHaveLength(0);
    expect(alarms.length).toBe(before);
    void throwingRepo;
  });

  it('does not pollute prototypes via __proto__ file paths', async () => {
    const { db, checkRuns } = createCheckDb();
    const stub = defaultRepoStub({
      listAllFiles: async () => [{ path: '__proto__', oid: OID_A }],
      getBlob: async () => textBlob('# harmless'),
    });
    const worker = new CheckRunnerWorker(fakeCheckState(new Map()), checkEnv(db, stub));
    await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: OID_A, contexts: ['secret-scan'], actorEmail: 'a@x.com' });
    await worker.alarm();
    expect(checkRuns).toHaveLength(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReadModelService: branches / tree / blob / commits
// ---------------------------------------------------------------------------
describe('background-low-fill ReadModelService', () => {
  it('getBranches returns branches and null when currentBranch is missing', async () => {
    const git = makeReadGit();
    const svc = new ReadModelService(git as never);
    await expect(svc.getBranches()).resolves.toEqual({ branches: ['main', 'feat'], currentBranch: 'main' });
    const gitNull = makeReadGit({ currentBranch: vi.fn(async () => null) });
    await expect(new ReadModelService(gitNull as never).getBranches()).resolves.toEqual({
      branches: ['main', 'feat'],
      currentBranch: null,
    });
  });

  it('getTags enriches lightweight vs annotated and sorts by name', async () => {
    const git = makeReadGit({
      listTags: vi.fn(async () => [
        { ref: 'refs/tags/v2', oid: OID_B },
        { ref: 'refs/tags/v1', oid: OID_A },
      ]),
      peelTag: vi.fn(async (oid: string) => (oid === OID_B ? OID_A : null)),
    });
    const svc = new ReadModelService(git as never);
    const tags = await svc.getTags();
    expect(tags).toEqual([
      { name: 'v1', ref: 'refs/tags/v1', oid: OID_A, peeledOid: null, type: 'lightweight' },
      { name: 'v2', ref: 'refs/tags/v2', oid: OID_B, peeledOid: OID_A, type: 'annotated' },
    ]);
  });

  it('getTree returns [] for unresolved refs', async () => {
    const git = makeReadGit();
    const svc = new ReadModelService(git as never);
    await expect(svc.getTree({ ref: 'missing' })).resolves.toEqual([]);
  });

  it('getTree maps lastCommit null when withLastCommit is false', async () => {
    const git = makeReadGit({
      getTree: vi.fn(async () => [{ path: 'a.txt', type: 'blob', oid: OID_A }]),
    });
    const svc = new ReadModelService(git as never);
    const tree = (await svc.getTree({ ref: 'main', withLastCommit: false })) as Array<Record<string, unknown>>;
    expect(tree).toEqual([{ path: 'a.txt', type: 'blob', oid: OID_A, lastCommit: null }]);
    expect(git.getLog).not.toHaveBeenCalled();
  });

  it('getTree attaches per-file lastCommit when withLastCommit is true', async () => {
    const commit = { oid: OID_A };
    const git = makeReadGit({
      getTree: vi.fn(async () => [{ path: 'a.txt', type: 'blob', oid: OID_A }]),
      getLog: vi.fn(async () => [commit]),
    });
    const svc = new ReadModelService(git as never);
    const tree = (await svc.getTree({ ref: 'main' })) as Array<Record<string, unknown>>;
    expect(tree[0]).toMatchObject({ path: 'a.txt', lastCommit: commit });
    expect(git.getLog).toHaveBeenCalledWith({ ref: 'main', depth: 1, filepath: 'a.txt' });
  });

  it('listAllFiles walks trees breadth-first and caps maxFiles', async () => {
    const git = makeReadGit({
      getTree: vi.fn(async (ref: string, dir: string) => {
        if (dir === '')
          return [
            { path: 'src', type: 'tree', oid: OID_A },
            { path: 'a.txt', type: 'blob', oid: OID_B },
          ];
        if (dir === 'src') return [{ path: 'b.txt', type: 'blob', oid: OID_C }];
        return [];
      }),
    });
    const svc = new ReadModelService(git as never);
    const files = await svc.listAllFiles({ ref: 'main', maxFiles: 10 });
    expect(files).toEqual([
      { path: 'a.txt', oid: OID_B },
      { path: 'src/b.txt', oid: OID_C },
    ]);
    const capped = await svc.listAllFiles({ ref: 'main', maxFiles: 1 });
    expect(capped).toHaveLength(1);
  });

  it('listAllFiles returns [] for unresolved refs and tolerates tree errors', async () => {
    const git = makeReadGit({
      getTree: vi.fn(async () => {
        throw new Error('gone');
      }),
    });
    const svc = new ReadModelService(git as never);
    // unresolved ref short-circuits before getTree
    await expect(svc.listAllFiles({ ref: 'missing' })).resolves.toEqual([]);
    // tree errors are swallowed per-directory
    await expect(svc.listAllFiles({ ref: 'main' })).resolves.toEqual([]);
  });

  it('getBlob returns null for unresolved refs and missing blobs', async () => {
    const git = makeReadGit({ getBlob: vi.fn(async () => null) });
    const svc = new ReadModelService(git as never);
    await expect(svc.getBlob({ ref: 'missing', filepath: 'a.txt' })).resolves.toBeNull();
    await expect(svc.getBlob({ ref: 'main', filepath: 'a.txt' })).resolves.toBeNull();
  });

  it('getBlob serializes Uint8Array content to base64', async () => {
    const bytes = new TextEncoder().encode('hello');
    const git = makeReadGit({ getBlob: vi.fn(async () => ({ oid: OID_A, content: bytes, size: 5, isBinary: false })) });
    const svc = new ReadModelService(git as never);
    const blob = (await svc.getBlob({ ref: 'main', filepath: 'a.txt' })) as Record<string, unknown>;
    expect(blob.contentBase64).toBe(Buffer.from('hello').toString('base64'));
  });

  it('getCommits returns [] when no latest commit and delegates otherwise', async () => {
    const empty = makeReadGit({ getLastCommit: vi.fn(async () => null) });
    await expect(new ReadModelService(empty as never).getCommits({ ref: 'main' })).resolves.toEqual([]);
    expect(empty.getLog).not.toHaveBeenCalled();
    const commits = [{ oid: OID_A }];
    const full = makeReadGit({ getLastCommit: vi.fn(async () => ({ oid: OID_A })), getLog: vi.fn(async () => commits) });
    await expect(new ReadModelService(full as never).getCommits({ ref: 'main', depth: 5 })).resolves.toEqual(commits);
    expect(full.getLog).toHaveBeenCalledWith({ ref: 'main', depth: 5 });
  });

  it('getLatestCommit delegates to git', async () => {
    const git = makeReadGit({ getLastCommit: vi.fn(async (b: string) => ({ oid: OID_A, branch: b })) });
    const svc = new ReadModelService(git as never);
    await expect(svc.getLatestCommit('main')).resolves.toMatchObject({ oid: OID_A });
    expect(git.getLastCommit).toHaveBeenCalledWith('main');
  });

  it('getOverview returns empty tree/commits when ref is unresolvable', async () => {
    const git = makeReadGit();
    const svc = new ReadModelService(git as never);
    const out = (await svc.getOverview({ ref: 'missing' })) as Record<string, unknown>;
    expect(out.resolvedRef).toBeNull();
    expect(out.tree).toEqual([]);
    expect(out.commits).toEqual([]);
    expect(out.readme).toBeNull();
  });

  it('getOverview inlines a small README and skips tags when includeTags is false', async () => {
    const bytes = new TextEncoder().encode('# hi');
    const git = makeReadGit({
      listBranches: vi.fn(async () => ['main']),
      currentBranch: vi.fn(async () => 'main'),
      resolveRef: vi.fn(async () => OID_A),
      getTree: vi.fn(async () => [{ path: 'README.md', type: 'blob', oid: OID_A }]),
      getLastCommit: vi.fn(async () => ({ oid: OID_A })),
      getLog: vi.fn(async () => [{ oid: OID_A }]),
      getBlob: vi.fn(async () => ({ oid: OID_A, content: bytes, size: 4, isBinary: false })),
      listTags: vi.fn(async () => [{ ref: 'refs/tags/v1', oid: OID_A }]),
    });
    const svc = new ReadModelService(git as never);
    const out = (await svc.getOverview({ ref: 'main', includeTags: false })) as Record<string, unknown>;
    expect(out.tags).toEqual([]);
    expect(out.tree).toHaveLength(1);
    expect(out.readme).toMatchObject({ path: 'README.md' });
    expect(git.listTags).not.toHaveBeenCalled();
  });

  it('getOverview marks oversized READMEs truncated without bytes', async () => {
    const git = makeReadGit({
      resolveRef: vi.fn(async () => OID_A),
      getTree: vi.fn(async () => [{ path: 'README.md', type: 'blob', oid: OID_A }]),
      getLastCommit: vi.fn(async () => ({ oid: OID_A })),
      getLog: vi.fn(async () => []),
      getBlob: vi.fn(async () => ({ oid: OID_A, content: new Uint8Array([1]), size: 600 * 1024, isBinary: false })),
    });
    const svc = new ReadModelService(git as never);
    const out = (await svc.getOverview({ ref: 'main' })) as { readme: Record<string, unknown> };
    expect(out.readme.truncated).toBe(true);
    expect(out.readme.contentBase64).toBeUndefined();
  });

  it('getPullDiff slices single-commit changes and uses merge-base otherwise', async () => {
    const changes = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
    const single = makeReadGit({ getCommit: vi.fn(async () => ({ changes })) });
    const out1 = (await new ReadModelService(single as never).getPullDiff(null, OID_A, 2)) as Record<string, unknown>;
    expect(out1).toMatchObject({ mergeBase: null, truncated: true });
    expect(out1.changes as unknown[]).toHaveLength(2);

    const two = makeReadGit({ findMergeBase: vi.fn(async () => OID_B), getFileStateChanges: vi.fn(async () => changes) });
    const out2 = (await new ReadModelService(two as never).getPullDiff(OID_B, OID_A, 10)) as Record<string, unknown>;
    expect(out2).toMatchObject({ mergeBase: OID_B, truncated: false });
  });

  it('getCompare/getMergePreview/getBlame delegate to git', async () => {
    const git = makeReadGit();
    const svc = new ReadModelService(git as never);
    await svc.getCompare('main', 'feat', 5);
    expect(git.getCompareDiff).toHaveBeenCalledWith('main', 'feat', 5);
    await svc.getMergePreview('main', 'feat');
    expect(git.getMergePreview).toHaveBeenCalledWith('main', 'feat');
    await svc.getMergePreviewByOids(OID_A, OID_B);
    expect(git.getMergePreviewByOids).toHaveBeenCalledWith(OID_A, OID_B);
    await svc.getCommit(OID_A);
    expect(git.getCommit).toHaveBeenCalledWith(OID_A);
    await svc.getCommitDiff(OID_A, 7);
    expect(git.getCommitDiff).toHaveBeenCalledWith(OID_A, 7);
    await svc.getBlame('main', 'a.txt');
    expect(git.getBlame).toHaveBeenCalledWith('main', 'a.txt');
  });
});

// ---------------------------------------------------------------------------
// FetchHandler: caps + fetch paths
// ---------------------------------------------------------------------------
describe('background-low-fill FetchHandler', () => {
  it('rejects too many ls-refs args with 400 before git I/O', async () => {
    const git = fakeFetchGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const data = encodeCommand(
      'ls-refs',
      Array.from({ length: 65 }, (_, i) => `arg-${i}`),
    );
    const res = await handler.uploadPack(data, FETCH_LIMITS);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('too many');
    expect(git.listRefs).not.toHaveBeenCalled();
  });

  it('rejects a single ls-refs arg that is too long with 400', async () => {
    const git = fakeFetchGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const data = encodeCommand('ls-refs', ['x'.repeat(1025)]);
    const res = await handler.uploadPack(data, FETCH_LIMITS);
    expect(res.status).toBe(400);
    expect(git.listRefs).not.toHaveBeenCalled();
  });

  it('returns an empty fetch response when wants are empty', async () => {
    const git = fakeFetchGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const data = encodeCommand('fetch', ['done']);
    const res = await handler.uploadPack(data, FETCH_LIMITS);
    expect(res.status).toBe(200);
    expect(git.collectObjectsForPack).not.toHaveBeenCalled();
  });

  it('rejects invalid want OIDs with 400', async () => {
    const git = fakeFetchGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const data = encodeCommand('fetch', ['want xyz', 'done']);
    const res = await handler.uploadPack(data, FETCH_LIMITS);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('invalid want');
    expect(git.collectObjectsForPack).not.toHaveBeenCalled();
  });

  it('maps pack limit errors to 413 pack-too-large', async () => {
    const git = fakeFetchGit({
      findCommonCommits: vi.fn().mockResolvedValue([]),
      collectObjectsForPack: vi.fn().mockResolvedValue({ oids: [OID_A], shallow: [] }),
      packObjects: vi.fn().mockResolvedValue(new Uint8Array(100)),
    });
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const data = encodeCommand('fetch', [`want ${OID_A}`, 'done']);
    const res = await handler.uploadPack(data, { ...FETCH_LIMITS, maxPackBytes: 10 });
    expect(res.status).toBe(413);
    expect(await res.text()).toContain('pack too large');
  });

  it('rejects fetch bodies over maxFetchBodyBytes with 413', async () => {
    const git = fakeFetchGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const res = await handler.uploadPack(new Uint8Array(11), { ...FETCH_LIMITS, maxFetchBodyBytes: 10 });
    expect(res.status).toBe(413);
  });

  it('rejects unsupported commands with 400', async () => {
    const git = fakeFetchGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const data = encodeCommand('nope-cmd', []);
    const res = await handler.uploadPack(data, FETCH_LIMITS);
    expect(res.status).toBe(400);
  });

  it('rejects unsupported filters with 400', async () => {
    const git = fakeFetchGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const data = encodeCommand('fetch', [`want ${OID_A}`, 'done', 'filter unknown:123']);
    const res = await handler.uploadPack(data, FETCH_LIMITS);
    expect(res.status).toBe(400);
    expect(git.collectObjectsForPack).not.toHaveBeenCalled();
  });

  it('serves ls-refs and successful fetch packs with 200', async () => {
    const gitLs = fakeFetchGit({
      listRefs: vi.fn().mockResolvedValue({ refs: [{ ref: 'refs/heads/main', oid: OID_A }], symbolicHead: null }),
    });
    const lsHandler = new FetchHandler({ git: gitLs, env: {} as Env, getFullName: () => 'a/b' });
    const lsRes = await lsHandler.uploadPack(encodeCommand('ls-refs', []), FETCH_LIMITS);
    expect(lsRes.status).toBe(200);

    const gitFetch = fakeFetchGit({
      findCommonCommits: vi.fn().mockResolvedValue([]),
      collectObjectsForPack: vi.fn().mockResolvedValue({ oids: [OID_A], shallow: [] }),
      packObjects: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    });
    const fetchHandler = new FetchHandler({ git: gitFetch, env: {} as Env, getFullName: () => 'a/b' });
    const fetchRes = await fetchHandler.uploadPack(encodeCommand('fetch', [`want ${OID_A}`, 'done']), FETCH_LIMITS);
    expect(fetchRes.status).toBe(200);
  });

  it('maps generic pack failures to 500', async () => {
    const git = fakeFetchGit({
      findCommonCommits: vi.fn().mockResolvedValue([]),
      collectObjectsForPack: vi.fn().mockRejectedValue(new Error('disk gone')),
    });
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const data = encodeCommand('fetch', [`want ${OID_A}`, 'done']);
    const res = await handler.uploadPack(data, FETCH_LIMITS);
    expect(res.status).toBe(500);
  });

  it('maps PackLimitError from findCommonCommits to 400', async () => {
    const git = fakeFetchGit({ findCommonCommits: vi.fn().mockRejectedValue(new PackLimitError('too many haves')) });
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const data = encodeCommand('fetch', [`want ${OID_A}`, `have ${OID_B}`, 'done']);
    const res = await handler.uploadPack(data, FETCH_LIMITS);
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// RealtimeWorker: tickets / presence / stats
// ---------------------------------------------------------------------------
describe('background-low-fill RealtimeWorker', () => {
  it('mints tickets with TTL metadata and defaults viewer to anonymous', async () => {
    const { worker, store } = makeRealtimeWorker('repo:alice/demo');
    const issued = await worker.issueTicket({ shard: 'repo:alice/demo', channels: ['activity', 'presence'] });
    expect(issued).toMatchObject({ ticket: expect.any(String) });
    if (!('ticket' in issued)) throw new Error('expected ticket');
    const record = store.get(`ticket:${issued.ticket}`) as { viewer: string; expiresAt: number; channels: string[] };
    expect(record.viewer).toBe('anonymous');
    expect(record.channels).toEqual(['activity', 'presence']);
    expect(record.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects invalid shards, shard mismatches and empty channels', async () => {
    const { worker } = makeRealtimeWorker('repo:alice/demo');
    await expect(worker.issueTicket({ shard: 'bogus', channels: ['activity'] })).resolves.toMatchObject({ error: expect.any(String) });
    await expect(worker.issueTicket({ shard: 'repo:alice/demo', channels: [] })).resolves.toMatchObject({ error: expect.any(String) });
    await expect(worker.issueTicket({ shard: 'repo:alice/demo', channels: ['bogus!!'] })).resolves.toMatchObject({
      error: expect.any(String),
    });
    await expect(worker.issueTicket({ shard: 'repo:bob/other', channels: ['activity'] })).resolves.toMatchObject({
      error: expect.any(String),
    });
  });

  it('garbage-collects expired tickets on alarm and tolerates empty stores', async () => {
    const { worker, store } = makeRealtimeWorker('repo:alice/demo');
    const now = Math.floor(Date.now() / 1000);
    store.set('ticketIds', ['old', 'live']);
    store.set('ticket:old', { shard: 'repo:alice/demo', channels: ['activity'], viewer: 'a', expiresAt: now - 10 });
    store.set('ticket:live', { shard: 'repo:alice/demo', channels: ['activity'], viewer: 'b', expiresAt: now + 100 });
    await worker.alarm();
    expect(store.has('ticket:old')).toBe(false);
    expect(store.get('ticketIds')).toEqual(['live']);

    const fresh = makeRealtimeWorker('repo:alice/demo');
    await expect(fresh.worker.alarm()).resolves.toBeUndefined();
  });

  it('getStats counts live connections and degrades to zero on throw', async () => {
    const { worker, ctx } = makeRealtimeWorker('repo:alice/demo');
    ctx.acceptWebSocket(makeSocket(), ['activity']);
    ctx.acceptWebSocket(makeSocket(), ['activity']);
    await expect(worker.getStats()).resolves.toEqual({ connections: 2 });

    const broken = makeRealtimeWorker('repo:alice/demo');
    (broken as unknown as { worker: RealtimeWorker }).worker;
    const throwingCtx = {
      getWebSockets: () => {
        throw new Error('gone');
      },
    } as unknown as DurableObjectState;
    const throwing = new RealtimeWorker(throwingCtx, {} as Env);
    await expect(throwing.getStats()).resolves.toEqual({ connections: 0 });
  });

  it('broadcasts to channel sockets and drops invalid channels', async () => {
    const { worker, ctx } = makeRealtimeWorker('repo:alice/demo');
    const first = makeSocket();
    const other = makeSocket();
    ctx.acceptWebSocket(first, ['issue:1']);
    ctx.acceptWebSocket(other, ['activity']);
    const result = await worker.publish({ channel: 'issue:1', type: 'issue_commented', actor: 'a@x.com', title: 'hi' });
    expect(result).toEqual({ delivered: 1 });
    expect(first.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(0);
    await expect(worker.publish({ channel: 'bogus', type: 'x', title: '' })).resolves.toEqual({ delivered: 0 });
  });

  it('relays typing indicators and presence heartbeats to subscribers', async () => {
    const { worker, ctx } = makeRealtimeWorker('repo:alice/demo');
    const author = makeSocket({ viewer: 'a@x.com', channels: ['issue:2'], connectedAt: 0, frameTimes: [] });
    const watcher = makeSocket();
    ctx.acceptWebSocket(author, ['issue:2']);
    ctx.acceptWebSocket(watcher, ['issue:2']);
    await worker.webSocketMessage(author as unknown as WebSocket, JSON.stringify({ kind: 'typing.start', channel: 'issue:2' }));
    expect(watcher.sent).toHaveLength(1);
    expect(JSON.parse(watcher.sent[0])).toMatchObject({ channel: 'issue:2', type: 'typing.started' });

    const presenceSock = makeSocket({ viewer: 'p@x.com', channels: ['presence'], connectedAt: 0, frameTimes: [] });
    const presenceWatcher = makeSocket();
    ctx.acceptWebSocket(presenceSock, ['presence']);
    ctx.acceptWebSocket(presenceWatcher, ['presence']);
    await worker.webSocketMessage(
      presenceSock as unknown as WebSocket,
      JSON.stringify({ kind: 'presence.heartbeat', channel: 'presence' }),
    );
    const updates = presenceWatcher.sent.map((raw) => JSON.parse(raw)).filter((e) => e.type === 'presence.update');
    expect(updates.length).toBeGreaterThan(0);
  });

  it('rate-limits chatty presence sockets', async () => {
    const { worker, ctx } = makeRealtimeWorker('repo:alice/demo');
    const socket = makeSocket({ viewer: 'a@x.com', channels: ['presence'], connectedAt: 0, frameTimes: [] });
    ctx.acceptWebSocket(socket, ['presence']);
    for (let i = 0; i < 31; i++) {
      await worker.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ kind: 'presence.heartbeat', channel: 'presence' }));
    }
    expect(socket.closed).toMatchObject({ code: 4408 });
  });

  it('ignores oversized, empty, non-string and unsubscribed frames', async () => {
    const { worker, ctx } = makeRealtimeWorker('repo:alice/demo');
    const socket = makeSocket({ viewer: 'a@x.com', channels: ['issue:2'], connectedAt: 0, frameTimes: [] });
    const watcher = makeSocket();
    ctx.acceptWebSocket(socket, ['issue:2']);
    ctx.acceptWebSocket(watcher, ['issue:2']);
    await worker.webSocketMessage(socket as unknown as WebSocket, '');
    await worker.webSocketMessage(socket as unknown as WebSocket, 'x'.repeat(5000));
    await worker.webSocketMessage(socket as unknown as WebSocket, new Uint8Array([1, 2]) as unknown as string);
    await worker.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ kind: 'typing.start', channel: 'issue:9' }));
    await worker.webSocketMessage(socket as unknown as WebSocket, 'not-json');
    const noAttach = makeSocket(null);
    ctx.acceptWebSocket(noAttach, ['issue:2']);
    await worker.webSocketMessage(noAttach as unknown as WebSocket, JSON.stringify({ kind: 'typing.start', channel: 'issue:2' }));
    expect(watcher.sent).toHaveLength(0);
    expect(socket.closed).toBeNull();
  });

  it('broadcasts presence on close and closes errored sockets', async () => {
    const { worker, ctx } = makeRealtimeWorker('repo:alice/demo');
    const leaving = makeSocket({ viewer: 'gone@x.com', channels: ['presence'], connectedAt: 0, frameTimes: [] });
    const staying = makeSocket({ viewer: 'here@x.com', channels: ['presence'], connectedAt: 0, frameTimes: [] });
    ctx.acceptWebSocket(leaving, ['presence']);
    ctx.acceptWebSocket(staying, ['presence']);
    leaving.closed = { code: 1000, reason: '' };
    await worker.webSocketClose(leaving as unknown as WebSocket, 1000, '', true);
    const updates = staying.sent.map((raw) => JSON.parse(raw)).filter((e) => e.type === 'presence.update');
    expect(updates.length).toBeGreaterThan(0);

    const errSock = makeSocket({ viewer: 'e@x.com', channels: [], connectedAt: 0, frameTimes: [] });
    await worker.webSocketError(errSock as unknown as WebSocket, new Error('boom'));
    expect(errSock.closed).toMatchObject({ code: 1011 });
  });

  it('fetch rejects unknown shards, missing upgrades, disabled realtime and bad tickets', async () => {
    const { worker } = makeRealtimeWorker('repo:alice/demo', { REALTIME_ENABLED: 'true' });
    const notFound = await worker.fetch(new Request('https://x/ws?shard=bogus&ticket=t'));
    expect(notFound.status).toBe(404);
    const noUpgrade = await worker.fetch(new Request('https://x/ws?shard=repo:alice/demo&ticket=t'));
    expect(noUpgrade.status).toBe(426);

    const disabled = makeRealtimeWorker('repo:alice/demo', {}).worker;
    const disabledRes = await disabled.fetch(
      new Request('https://x/ws?shard=repo:alice/demo&ticket=t', { headers: { Upgrade: 'websocket' } }),
    );
    expect(disabledRes.status).toBe(503);

    const badTicket = await worker.fetch(
      new Request('https://x/ws?shard=repo:alice/demo&ticket=missing', { headers: { Upgrade: 'websocket' } }),
    );
    expect(badTicket.status).toBe(401);
  });

  it('fetch returns 503 when the shard is full', async () => {
    const { worker, ctx, store } = makeRealtimeWorker('repo:alice/demo', {
      REALTIME_ENABLED: 'true',
      REALTIME_MAX_CONN_PER_REPO_SHARD: '1',
    });
    const now = Math.floor(Date.now() / 1000);
    store.set('ticketIds', ['t1']);
    store.set('ticket:t1', { shard: 'repo:alice/demo', channels: ['activity'], viewer: 'anonymous', expiresAt: now + 100 });
    ctx.acceptWebSocket(makeSocket({ viewer: 'anonymous', channels: ['activity'], connectedAt: 0, frameTimes: [] }), []);
    const res = await worker.fetch(new Request('https://x/ws?shard=repo:alice/demo&ticket=t1', { headers: { Upgrade: 'websocket' } }));
    expect(res.status).toBe(503);
  });

  it('fetch returns 404 for non-ws paths', async () => {
    const { worker } = makeRealtimeWorker('repo:alice/demo');
    const res = await worker.fetch(new Request('https://x/unknown'));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// RepoWorker: fetch routing via prototype injection
// ---------------------------------------------------------------------------
describe('background-low-fill RepoWorker fetch routing', () => {
  it('routes POST /git-receive-pack to the push handler', async () => {
    const storage = repoStorage();
    const lifecycle = {
      ensureDeviceSize: vi.fn(),
      ensureRepoInitialized: vi.fn(async () => undefined),
      getLimits: () => ({ maxObjects: 1, maxPackBytes: 2 }),
    };
    const receivePack = vi.fn(async () => new Response('pushed'));
    const worker = makeRepoWorker({
      ctx: { storage },
      fullNameValue: 'alice/demo',
      lifecycle,
      pushHandler: { receivePack },
      fetchHandler: { uploadPack: vi.fn() },
    });
    const body = new Uint8Array([1, 2, 3]);
    const res = await worker.fetch(new Request('https://x/git-receive-pack', { method: 'POST', body }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pushed');
    expect(lifecycle.ensureDeviceSize).toHaveBeenCalledTimes(1);
    expect(lifecycle.ensureRepoInitialized).toHaveBeenCalledTimes(1);
    expect(receivePack).toHaveBeenCalledTimes(1);
    const data = receivePack.mock.calls[0][0] as Uint8Array;
    expect([...data]).toEqual([1, 2, 3]);
  });

  it('routes POST /git-upload-pack to the fetch handler', async () => {
    const storage = repoStorage();
    const lifecycle = {
      ensureDeviceSize: vi.fn(),
      ensureRepoInitialized: vi.fn(async () => undefined),
      getLimits: () => ({ maxObjects: 1, maxPackBytes: 2 }),
    };
    const uploadPack = vi.fn(async () => new Response('fetched'));
    const worker = makeRepoWorker({
      ctx: { storage },
      fullNameValue: 'alice/demo',
      lifecycle,
      pushHandler: { receivePack: vi.fn() },
      fetchHandler: { uploadPack },
    });
    const body = new Uint8Array([4, 5]);
    const res = await worker.fetch(new Request('https://x/git-upload-pack', { method: 'POST', body }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('fetched');
    expect(uploadPack).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for POST /ensure with an invalid fullName', async () => {
    const storage = repoStorage();
    const lifecycle = { ensureDeviceSize: vi.fn(), ensureRepoInitialized: vi.fn(async () => undefined) };
    const worker = makeRepoWorker({ ctx: { storage }, lifecycle });
    const res = await worker.fetch(
      new Request('https://x/ensure', {
        method: 'POST',
        body: JSON.stringify({ fullName: 'no-slash' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(400);
    expect(lifecycle.ensureRepoInitialized).not.toHaveBeenCalled();
  });

  it('accepts POST /ensure with a valid fullName and persists it once', async () => {
    const storage = repoStorage();
    const lifecycle = { ensureDeviceSize: vi.fn(), ensureRepoInitialized: vi.fn(async () => undefined) };
    const worker = makeRepoWorker({ ctx: { storage }, lifecycle });
    const res = await worker.fetch(
      new Request('https://x/ensure', {
        method: 'POST',
        body: JSON.stringify({ fullName: 'alice/repo' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(storage.put).toHaveBeenCalledWith('fullName', 'alice/repo');
    expect(worker.fullName).toBe('alice/repo');
    expect(lifecycle.ensureRepoInitialized).toHaveBeenCalledTimes(1);
  });

  it('returns 404 for unknown paths and wrong methods', async () => {
    const worker = makeRepoWorker({});
    expect((await worker.fetch(new Request('https://x/unknown-path'))).status).toBe(404);
    expect((await worker.fetch(new Request('https://x/git-receive-pack', { method: 'GET' }))).status).toBe(404);
    expect((await worker.fetch(new Request('https://x/git-upload-pack', { method: 'GET' }))).status).toBe(404);
  });

  it('receivePack and uploadPack dispatch with lifecycle limits', async () => {
    const limits = { maxWants: 1, maxHaves: 2, maxCommands: 3, maxObjects: 4, maxPackBytes: 5, maxFetchBodyBytes: 6 };
    const receivePack = vi.fn(async () => new Response('pushed'));
    const uploadPack = vi.fn(async () => new Response('fetched'));
    const worker = makeRepoWorker({
      lifecycle: { getLimits: () => limits },
      pushHandler: { receivePack },
      fetchHandler: { uploadPack },
    });
    const data = new Uint8Array([1]);
    await worker.receivePack(data, []);
    expect(receivePack).toHaveBeenCalledWith(data, limits, []);
    await worker.uploadPack(data);
    expect(uploadPack).toHaveBeenCalledWith(data, limits);
  });

  it('setFullName validates, persists once, and deleteRepo clears the cache', async () => {
    const storage = repoStorage();
    const deleteRepo = vi.fn(async () => undefined);
    const worker = makeRepoWorker({ ctx: { storage }, lifecycle: { deleteRepo }, git: { clearCache: vi.fn() } });
    expect(() => worker.fullName).toThrow('Repository full name is not set');
    await expect(worker.setFullName('no-slash')).rejects.toThrow('Invalid repository full name');
    await worker.setFullName('alice/repo');
    expect(worker.fullName).toBe('alice/repo');
    expect(storage.put).toHaveBeenCalledWith('fullName', 'alice/repo');
    // BREAKING: renames update the binding instead of being ignored.
    await worker.setFullName('bob/other');
    expect(storage.put).toHaveBeenCalledTimes(2);
    expect(worker.fullName).toBe('bob/other');
    await worker.deleteRepo();
    expect(deleteRepo).toHaveBeenCalledTimes(1);
    expect(() => worker.fullName).toThrow('Repository full name is not set');
  });

  it('loads fullName from storage when the in-memory value is missing', async () => {
    const storage = repoStorage({ fullName: 'alice/cached' });
    const lifecycle = { ensureDeviceSize: vi.fn(), ensureRepoInitialized: vi.fn(async () => undefined), getLimits: () => ({}) };
    const uploadPack = vi.fn(async () => new Response('ok'));
    const worker = makeRepoWorker({ ctx: { storage }, lifecycle, fetchHandler: { uploadPack }, pushHandler: { receivePack: vi.fn() } });
    const res = await worker.fetch(new Request('https://x/git-upload-pack', { method: 'POST', body: new Uint8Array([1]) }));
    expect(res.status).toBe(200);
    expect(storage.get).toHaveBeenCalledWith('fullName');
    expect(worker.fullName).toBe('alice/cached');
  });

  it('delegates read-model RPCs to the reads fan-out', async () => {
    const reads = {
      getBranches: vi.fn(async () => ({ branches: ['main'], currentBranch: 'main' })),
      getLatestCommit: vi.fn(async () => ({ oid: OID_A })),
      listAllFiles: vi.fn(async () => []),
    };
    const worker = makeRepoWorker({ reads });
    await expect(worker.getBranches()).resolves.toEqual({ branches: ['main'], currentBranch: 'main' });
    await worker.getLatestCommit('main');
    expect(reads.getLatestCommit).toHaveBeenCalledWith('main');
    await worker.listAllFiles({ ref: 'main' });
    expect(reads.listAllFiles).toHaveBeenCalledWith({ ref: 'main' });
  });

  it('uses zero OID constants without unused warnings', () => {
    expect(OID_ZERO).toBe('0'.repeat(40));
    expect(OID_C).toHaveLength(40);
  });
});
