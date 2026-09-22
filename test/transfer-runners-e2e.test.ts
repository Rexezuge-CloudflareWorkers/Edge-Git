import { afterEach, describe, expect, it, vi } from 'vitest';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { PktLine } from '@edge-git/git-protocol';
import { runImportJob } from '@edge-git/background/transfer/ImportRunner';
import { runMirrorSync } from '@edge-git/background/transfer/MirrorRunner';

// Runner happy paths (Slice 5): ImportRunner/MirrorRunner sit at ~30% funcs.
// Smart HTTP is scripted via a stubbed global fetch (valid advertisement +
// sideband pack); D1 via a small fake; the repo DO via method stubs.

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_C = 'c'.repeat(40);

function advertisement(refs: Array<{ ref: string; oid: string }>): Uint8Array {
  return PktLine.mergeLines([
    PktLine.encode('# service=git-upload-pack\n'),
    PktLine.encodeFlush(),
    ...refs.map((r) => PktLine.encode(`${r.oid} ${r.ref}\0multi_ack\n`)),
  ]);
}

function sidebandPack(): Uint8Array {
  const payload = new Uint8Array([PktLine.SIDEBAND_CHANNEL_PACKFILE, ...new TextEncoder().encode('PACK12345678')]);
  const hex = (payload.length + 4).toString(16).padStart(4, '0');
  const out = new Uint8Array(4 + payload.length);
  out.set(new TextEncoder().encode(hex));
  out.set(payload, 4);
  return out;
}

function stubFetch(handler: (url: string) => Response) {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((url: unknown, init?: RequestInit) => {
    calls.push(String(url));
    void init;
    return Promise.resolve(handler(String(url)));
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

interface RunnerState {
  imports: Array<Record<string, unknown>>;
  mirrors: Array<Record<string, unknown>>;
  repos: Array<Record<string, unknown>>;
  failed: Array<{ id: string; message: string }>;
  done: Array<{ id: string; refs: number }>;
  runs: Array<{ repo: string; ok: boolean }>;
  deletedMirrors: string[];
}

function seedRunnerState(): RunnerState {
  return {
    imports: [
      {
        id: 'job1',
        repository_id: 'r1',
        source_url: 'https://github.com/o/r',
        status: 'pending',
        error: null,
        refs_json: null,
        imported_refs: 0,
        created_by: 'a@x.com',
        created_at: 1,
        updated_at: 1,
      },
    ],
    mirrors: [
      {
        repository_id: 'r1',
        source_url: 'https://github.com/o/r',
        interval_minutes: 60,
        enabled: 1,
        last_run_at: null,
        last_status: null,
        last_error: null,
        consecutive_failures: 0,
        created_by: 'a@x.com',
        created_at: 1,
        updated_at: 1,
      },
    ],
    repos: [
      {
        id: 'r1',
        owner_email: 'a@x.com',
        owner: 'alice',
        name: 'demo',
        is_private: 0,
        owner_type: 'user',
        owner_ci: 'alice',
        name_ci: 'demo',
        created_at: 1,
        updated_at: 1,
      },
    ],
    failed: [],
    done: [],
    runs: [],
    deletedMirrors: [],
  };
}

function runnerDb(state: RunnerState): D1Queryable {
  return {
    prepare(query: string) {
      const q = query.replace(/\s+/g, ' ').trim();
      return {
        bind(...params: unknown[]) {
          return {
            async first<T>() {
              if (q.includes('FROM repo_imports WHERE id = ?')) {
                return (state.imports.find((j) => j.id === params[0]) ?? null) as T | null;
              }
              if (q.includes('FROM repo_mirrors WHERE repository_id = ?')) {
                return (state.mirrors.find((m) => m.repository_id === params[0]) ?? null) as T | null;
              }
              if (q.includes('FROM repositories WHERE id = ?')) {
                return (state.repos.find((r) => r.id === params[0]) ?? null) as T | null;
              }
              return null;
            },
            async all<T>() {
              return { results: [] as T[] };
            },
            async run() {
              if (q.startsWith("UPDATE repo_imports SET status = 'failed'")) {
                const job = state.imports.find((j) => j.id === params[2]);
                if (job) {
                  job.status = 'failed';
                  job.error = params[0];
                  state.failed.push({ id: String(params[2]), message: String(params[0]) });
                }
                return { success: true };
              }
              if (q.startsWith("UPDATE repo_imports SET status = 'done'")) {
                const job = state.imports.find((j) => j.id === params[3]);
                if (job) {
                  job.status = 'done';
                  state.done.push({ id: String(params[3]), refs: Number(params[1]) });
                }
                return { success: true };
              }
              if (q.includes('UPDATE repo_mirrors SET last_run_at')) {
                const ok = q.includes("last_status = 'ok'");
                state.runs.push({ repo: String(params[params.length - 1]), ok });
                return { success: true };
              }
              if (q.startsWith('DELETE FROM repo_mirrors WHERE')) {
                state.deletedMirrors.push(String(params[0]));
                return { success: true };
              }
              return { success: true };
            },
          };
        },
      };
    },
  } as unknown as D1Queryable;
}

function repoStub(refs: Array<{ ref: string; oid: string }>, calls: Record<string, unknown[]>, opts: { ancestor?: boolean } = {}) {
  return {
    setFullName: async () => undefined,
    listRefs: async () => ({ refs, symbolicHead: 'refs/heads/main' }),
    importPack: async (pack: Uint8Array, refsArg?: Array<{ ref: string; oid: string }>) => {
      (calls.imports ??= []).push({ pack: pack.byteLength, refs: refsArg });
      return { importedRefs: (refsArg ?? []).map((r) => r.ref) };
    },
    resolveRef: async () => OID_A,
    isAncestor: async () => opts.ancestor ?? true,
    updateRefs: async (updates: unknown) => {
      (calls.updates ??= []).push(updates);
      return { updated: (updates as Array<{ ref: string }>).map((u) => u.ref) };
    },
  };
}

function runnerEnv(db: D1Queryable, stubs: Record<string, unknown>) {
  return {
    DB: db,
    REPO: { getByName: (name: string) => stubs[name], get: (name: string) => stubs[name], idFromName: (n: string) => n },
    ENVIRONMENT: 'development',
  } as unknown as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('slice5: runImportJob', () => {
  it('ignores missing and non-pending jobs', async () => {
    const state = seedRunnerState();
    state.imports = [];
    const env = runnerEnv(runnerDb(state), {});
    await expect(runImportJob(env, 'alice/demo', 'nope')).resolves.toBeUndefined();
    state.imports.push({ id: 'job2', repository_id: 'r1', source_url: 'https://github.com/o/r', status: 'done' });
    await expect(runImportJob(env, 'alice/demo', 'job2')).resolves.toBeUndefined();
    expect(state.failed).toHaveLength(0);
    expect(state.done).toHaveLength(0);
  });

  it('refuses non-empty repos', async () => {
    const state = seedRunnerState();
    const calls: Record<string, unknown[]> = {};
    const env = runnerEnv(runnerDb(state), { 'alice/demo': repoStub([{ ref: 'refs/heads/main', oid: OID_A }], calls) });
    await runImportJob(env, 'alice/demo', 'job1');
    expect(state.failed).toHaveLength(1);
    expect(state.failed[0]?.message).toContain('not empty');
  });

  it('imports an empty repo end to end', async () => {
    const state = seedRunnerState();
    const calls: Record<string, unknown[]> = {};
    const env = runnerEnv(runnerDb(state), { 'alice/demo': repoStub([], calls) });
    const fetch = stubFetch((url) => {
      if (url.includes('/info/refs')) {
        return new Response(advertisement([{ ref: 'refs/heads/main', oid: OID_A }]) as unknown as BodyInit, {
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
        });
      }
      return new Response(sidebandPack() as unknown as BodyInit, { status: 200 });
    });
    try {
      await runImportJob(env, 'alice/demo', 'job1');
      expect(state.done).toEqual([{ id: 'job1', refs: 1 }]);
      expect(fetch.calls.some((u) => u.includes('/git-upload-pack'))).toBe(true);
    } finally {
      fetch.restore();
    }
  });

  it('records fetch failures on the job row', async () => {
    const state = seedRunnerState();
    const calls: Record<string, unknown[]> = {};
    const env = runnerEnv(runnerDb(state), { 'alice/demo': repoStub([], calls) });
    const fetch = stubFetch(() => new Response('nope', { status: 500 }));
    try {
      await runImportJob(env, 'alice/demo', 'job1');
      expect(state.failed).toHaveLength(1);
      expect(state.done).toHaveLength(0);
    } finally {
      fetch.restore();
    }
  });
});

describe('slice5: runMirrorSync', () => {
  it('skips missing and disabled mirrors', async () => {
    const state = seedRunnerState();
    state.mirrors = [];
    const env = runnerEnv(runnerDb(state), {});
    await expect(runMirrorSync(env, 'r1')).resolves.toBeUndefined();
    state.mirrors.push({ repository_id: 'r1', source_url: 'https://github.com/o/r', interval_minutes: 60, enabled: 0 });
    await expect(runMirrorSync(env, 'r1')).resolves.toBeUndefined();
    expect(state.runs).toHaveLength(0);
  });

  it('deletes mirrors whose repo is gone', async () => {
    const state = seedRunnerState();
    state.repos = [];
    const env = runnerEnv(runnerDb(state), {});
    await runMirrorSync(env, 'r1');
    expect(state.deletedMirrors).toEqual(['r1']);
  });

  it('creates missing branches and fast-forwards heads', async () => {
    const state = seedRunnerState();
    const calls: Record<string, unknown[]> = {};
    const local = [
      { ref: 'refs/heads/main', oid: OID_A },
      { ref: 'refs/tags/v1', oid: OID_C },
    ];
    const env = runnerEnv(runnerDb(state), { 'alice/demo': repoStub(local, calls, { ancestor: true }) });
    const fetch = stubFetch((url) => {
      if (url.includes('/info/refs')) {
        return new Response(
          advertisement([
            { ref: 'refs/heads/main', oid: OID_B },
            { ref: 'refs/heads/feat', oid: OID_B },
            { ref: 'refs/tags/v1', oid: OID_C },
          ]) as unknown as BodyInit,
          { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } },
        );
      }
      return new Response(sidebandPack() as unknown as BodyInit, { status: 200 });
    });
    try {
      await runMirrorSync(env, 'r1');
      const updates = calls.updates?.[0] as Array<{ ref: string; oldOid: string; newOid: string }>;
      expect(updates.map((u) => u.ref).sort()).toEqual(['refs/heads/feat', 'refs/heads/main']);
      expect(updates.find((u) => u.ref === 'refs/heads/feat')?.oldOid).toBe('0'.repeat(40));
      expect(state.runs).toEqual([{ repo: 'r1', ok: true }]);
    } finally {
      fetch.restore();
    }
  });

  it('skips diverged branches without force-updating', async () => {
    const state = seedRunnerState();
    const calls: Record<string, unknown[]> = {};
    const env = runnerEnv(runnerDb(state), {
      'alice/demo': repoStub([{ ref: 'refs/heads/main', oid: OID_A }], calls, { ancestor: false }),
    });
    const fetch = stubFetch((url) => {
      if (url.includes('/info/refs')) {
        return new Response(advertisement([{ ref: 'refs/heads/main', oid: OID_B }]) as unknown as BodyInit, {
          status: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
        });
      }
      return new Response(sidebandPack() as unknown as BodyInit, { status: 200 });
    });
    try {
      await runMirrorSync(env, 'r1');
      expect(calls.updates ?? []).toHaveLength(0);
      expect(state.runs).toEqual([{ repo: 'r1', ok: true }]);
    } finally {
      fetch.restore();
    }
  });

  it('records failed runs when the remote is down', async () => {
    const state = seedRunnerState();
    const calls: Record<string, unknown[]> = {};
    const env = runnerEnv(runnerDb(state), { 'alice/demo': repoStub([], calls) });
    const fetch = stubFetch(() => new Response('down', { status: 500 }));
    try {
      await runMirrorSync(env, 'r1');
      expect(state.runs).toEqual([{ repo: 'r1', ok: false }]);
    } finally {
      fetch.restore();
    }
  });
});
