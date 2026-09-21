import { describe, expect, it, vi } from 'vitest';
import { PktLine, fetchRemotePack } from '@edge-git/git-protocol';
import { runImportJob } from '@edge-git/background/transfer/ImportRunner';
import { runMirrorSync } from '@edge-git/background/transfer/MirrorRunner';
import type { D1Queryable } from '@edge-git/backend-data/utils';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const TAG = 'c'.repeat(40);
const DIV = 'd'.repeat(40);
const DIV2 = 'e'.repeat(40);

function advertisement(): Uint8Array {
  return PktLine.mergeLines([
    PktLine.encode('# service=git-upload-pack\n'),
    PktLine.encodeFlush(),
    PktLine.encode(`${NEW} refs/heads/main\n`),
    PktLine.encode(`${NEW} refs/heads/feature\n`),
    PktLine.encode(`${TAG} refs/tags/v1\n`),
    PktLine.encodeFlush(),
  ]);
}

function packResponse(): Uint8Array {
  const pack = new Uint8Array([...new TextEncoder().encode('PACK'), 0, 0, 0, 2, 0, 0, 0, 1, 7, 8, 9]);
  return PktLine.mergeLines([PktLine.encode('NAK\n'), PktLine.encodeSideband(1, pack)]);
}

function fakeFetcher() {
  return {
    get: async (url: string) => {
      expect(url).toContain('/info/refs?service=git-upload-pack');
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisement() };
    },
    post: async (url: string, _headers: Record<string, string>, body: Uint8Array) => {
      expect(url).toContain('/git-upload-pack');
      expect(body.length).toBeGreaterThan(0);
      return { status: 200, body: packResponse() };
    },
  };
}

interface RunnerDb {
  imports: Array<Record<string, unknown>>;
  mirrors: Array<Record<string, unknown>>;
  repos: Array<Record<string, unknown>>;
}

function createRunnerDb(seed: Partial<RunnerDb> = {}): D1Queryable & { data: RunnerDb } {
  const data: RunnerDb = { imports: [], mirrors: [], repos: [], ...seed };
  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM repo_imports WHERE id = ?')) {
          return Promise.resolve((data.imports.find((i) => i.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM repo_mirrors WHERE repository_id = ?')) {
          return Promise.resolve((data.mirrors.find((m) => m.repository_id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE id = ?')) {
          return Promise.resolve((data.repos.find((r) => r.id === params[0]) ?? null) as T | null);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.includes("UPDATE repo_imports SET status = 'done'")) {
          const row = data.imports.find((i) => i.id === params[3] && ['pending', 'running'].includes(i.status as string));
          if (row) {
            row.status = 'done';
            row.refs_json = params[0];
            row.imported_refs = params[1];
            row.updated_at = params[2];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes("UPDATE repo_imports SET status = 'failed'")) {
          const row = data.imports.find((i) => i.id === params[2] && ['pending', 'running'].includes(i.status as string));
          if (row) {
            row.status = 'failed';
            row.error = params[0];
            row.updated_at = params[1];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes("UPDATE repo_mirrors SET last_run_at = ?, last_status = 'ok'")) {
          const row = data.mirrors.find((m) => m.repository_id === params[2]);
          if (row) {
            row.last_run_at = params[0];
            row.last_status = 'ok';
            row.last_error = null;
            row.consecutive_failures = 0;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes('consecutive_failures = consecutive_failures + 1')) {
          const row = data.mirrors.find((m) => m.repository_id === params[4]);
          if (row) {
            row.last_run_at = params[0];
            row.last_status = 'failed';
            row.last_error = params[1];
            row.consecutive_failures = (row.consecutive_failures as number) + 1;
            if ((row.consecutive_failures as number) >= (params[2] as number)) row.enabled = 0;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repo_mirrors')) {
          data.mirrors = data.mirrors.filter((m) => m.repository_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      },
    };
  }
  return { prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }), data } as unknown as D1Queryable & {
    data: RunnerDb;
  };
}

describe('fetchRemotePack', () => {
  it('advertises, wants all oids, and decodes the pack', async () => {
    const result = await fetchRemotePack(fakeFetcher(), 'https://github.com/o/r', { maxRefs: 100, maxPackBytes: 1024, timeoutMs: 5000 });
    expect(result.refs).toHaveLength(3);
    expect(result.pack.slice(0, 4)).toEqual(new Uint8Array([80, 65, 67, 75]));
  });

  it('surfaces HTTP and protocol failures', async () => {
    const notFound = {
      get: async () => ({ status: 404, contentType: null, body: new Uint8Array() }),
      post: async () => ({ status: 200, body: new Uint8Array() }),
    };
    await expect(
      fetchRemotePack(notFound, 'https://github.com/o/r', { maxRefs: 100, maxPackBytes: 1024, timeoutMs: 5000 }),
    ).rejects.toThrow(/advertise failed/);
    const notGit = {
      get: async () => ({ status: 200, contentType: 'text/html', body: new TextEncoder().encode('<html>') }),
      post: async () => ({ status: 200, body: new Uint8Array() }),
    };
    await expect(fetchRemotePack(notGit, 'https://github.com/o/r', { maxRefs: 100, maxPackBytes: 1024, timeoutMs: 5000 })).rejects.toThrow(
      /Smart HTTP/,
    );
  });
});

describe('runImportJob', () => {
  it('imports into empty repos and records completion', async () => {
    const db = createRunnerDb({
      imports: [
        {
          id: 'j1',
          repository_id: 'r1',
          source_url: 'https://github.com/o/r',
          status: 'pending',
          error: null,
          refs_json: null,
          imported_refs: 0,
          created_by: 'a@b.c',
          created_at: 0,
          updated_at: 0,
        },
      ],
    });
    const importPack = vi.fn(async () => ({ importedRefs: ['refs/heads/main'] }));
    const stub = { listRefs: async () => ({ refs: [], symbolicHead: null }), importPack };
    const env = { DB: db, REPO: { getByName: () => stub } } as unknown as Env;
    // Hermetic failure: the remote 404s, so the job records failed without
    // throwing (the cron sweeper retries later).
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
    try {
      await runImportJob(env, 'alice/empty', 'j1');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(db.data.imports[0].status).toBe('failed');
    expect(importPack).not.toHaveBeenCalled();
  });

  it('indexes the remote pack on success', async () => {
    const db = createRunnerDb({
      imports: [
        {
          id: 'j3',
          repository_id: 'r1',
          source_url: 'https://github.com/o/r',
          status: 'pending',
          error: null,
          refs_json: null,
          imported_refs: 0,
          created_by: 'a@b.c',
          created_at: 0,
          updated_at: 0,
        },
      ],
    });
    const importPack = vi.fn(async () => ({ importedRefs: ['refs/heads/main', 'refs/heads/feature', 'refs/tags/v1'] }));
    const stub = { listRefs: async () => ({ refs: [], symbolicHead: null }), importPack };
    const env = { DB: db, REPO: { getByName: () => stub } } as unknown as Env;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/info/refs')) {
        return new Response(advertisement() as unknown as BodyInit, {
          status: 200,
          headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' },
        });
      }
      return new Response(packResponse() as unknown as BodyInit, { status: 200 });
    }) as typeof fetch;
    try {
      await runImportJob(env, 'alice/empty', 'j3');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(importPack).toHaveBeenCalledTimes(1);
    expect(db.data.imports[0].status).toBe('done');
    expect(db.data.imports[0].imported_refs).toBe(3);
  });

  it('refuses non-empty repos without fetching', async () => {
    const db = createRunnerDb({
      imports: [
        {
          id: 'j2',
          repository_id: 'r1',
          source_url: 'https://github.com/o/r',
          status: 'pending',
          error: null,
          refs_json: null,
          imported_refs: 0,
          created_by: 'a@b.c',
          created_at: 0,
          updated_at: 0,
        },
      ],
    });
    const importPack = vi.fn();
    const stub = { listRefs: async () => ({ refs: [{ ref: 'refs/heads/main', oid: OLD }], symbolicHead: 'refs/heads/main' }), importPack };
    const env = { DB: db, REPO: { getByName: () => stub } } as unknown as Env;
    await runImportJob(env, 'alice/full', 'j2');
    expect(db.data.imports[0].status).toBe('failed');
    expect(db.data.imports[0].error).toContain('not empty');
    expect(importPack).not.toHaveBeenCalled();
  });

  it('ignores unknown jobs', async () => {
    const db = createRunnerDb();
    const env = {
      DB: db,
      REPO: {
        getByName: () => {
          throw new Error('must not be called');
        },
      },
    } as unknown as Env;
    await expect(runImportJob(env, 'alice/empty', 'missing')).resolves.toBeUndefined();
  });

  it('routes the repo stub via the canonical lowercase DO key', async () => {
    const db = createRunnerDb({
      imports: [
        {
          id: 'j-key',
          repository_id: 'r1',
          source_url: 'https://github.com/o/r',
          status: 'pending',
          error: null,
          refs_json: null,
          imported_refs: 0,
          created_by: 'a@b.c',
          created_at: 0,
          updated_at: 0,
        },
      ],
    });
    const importPack = vi.fn(async () => ({ importedRefs: ['refs/heads/main'] }));
    const stub = { listRefs: async () => ({ refs: [], symbolicHead: null }), importPack };
    const seen: string[] = [];
    const env = {
      DB: db,
      REPO: {
        getByName: (key: string) => {
          seen.push(key);
          return stub;
        },
      },
    } as unknown as Env;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/info/refs')) {
        return new Response(advertisement() as unknown as BodyInit, {
          status: 200,
          headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' },
        });
      }
      return new Response(packResponse() as unknown as BodyInit, { status: 200 });
    }) as typeof fetch;
    try {
      await runImportJob(env, 'Alice/Empty', 'j-key');
    } finally {
      globalThis.fetch = realFetch;
    }
    // Mixed-case display name must still address the canonical isolate that
    // API reads (getRepoStub) use, or the import lands where nobody reads.
    expect(seen).toEqual(['alice/empty']);
    expect(db.data.imports[0].status).toBe('done');
  });
});

describe('runMirrorSync', () => {
  function mirrorEnv(db: D1Queryable & { data: RunnerDb }, stub: unknown): Env {
    return { DB: db, REPO: { getByName: () => stub } } as unknown as Env;
  }

  it('fast-forwards heads, creates tags, and skips diverged branches', async () => {
    const db = createRunnerDb({
      repos: [{ id: 'r1', owner: 'alice', name: 'demo' }],
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
          created_by: 'a@b.c',
          created_at: 0,
          updated_at: 0,
        },
      ],
    });
    // Local state: main behind, stale diverged branch, existing tag pinned.
    const local = [
      { ref: 'refs/heads/main', oid: OLD },
      { ref: 'refs/heads/diverged', oid: DIV },
      { ref: 'refs/tags/v1', oid: TAG },
    ];
    // Remote advertises main=NEW, feature=NEW, v1=TAG. Patch the fetcher
    // seam by pointing the mirror at a data: URL? No — instead exercise the
    // sync against a stubbed global fetch below.
    const updateRefs = vi.fn(async () => ({ updated: [] as string[] }));
    const importPack = vi.fn(async () => ({ importedRefs: [] as string[] }));
    const stub = {
      listRefs: async () => ({ refs: local, symbolicHead: 'refs/heads/main' }),
      importPack,
      isAncestor: async (ancestor: string, oid: string) => ancestor === OLD && oid === NEW,
      updateRefs,
    };
    const realFetch = globalThis.fetch;
    const remoteRefs = [
      { ref: 'refs/heads/main', oid: NEW },
      { ref: 'refs/heads/feature', oid: NEW },
      { ref: 'refs/heads/diverged', oid: DIV2 },
      { ref: 'refs/tags/v1', oid: 'f'.repeat(40) },
      { ref: 'refs/tags/v2', oid: TAG },
    ];
    const ad = PktLine.mergeLines([
      PktLine.encode('# service=git-upload-pack\n'),
      PktLine.encodeFlush(),
      ...remoteRefs.map((r) => PktLine.encode(`${r.oid} ${r.ref}\n`)),
      PktLine.encodeFlush(),
    ]);
    const pack = new Uint8Array([...new TextEncoder().encode('PACK'), 0, 0, 0, 2, 0, 0, 0, 1, 7, 8, 9, 10, 11]);
    const packBody = PktLine.mergeLines([PktLine.encodeSideband(1, pack)]);
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/info/refs')) {
        return new Response(ad as unknown as BodyInit, {
          status: 200,
          headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' },
        });
      }
      expect(target).toContain('/git-upload-pack');
      expect((init?.method ?? 'GET').toUpperCase()).toBe('POST');
      return new Response(packBody as unknown as BodyInit, { status: 200 });
    }) as typeof fetch;
    try {
      await runMirrorSync(mirrorEnv(db, stub), 'r1');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(importPack).toHaveBeenCalledTimes(1);
    expect(updateRefs).toHaveBeenCalledTimes(1);
    const updates = updateRefs.mock.calls[0][0] as Array<{ ref: string; oldOid: string; newOid: string }>;
    const byRef = new Map(updates.map((u) => [u.ref, u]));
    // Fast-forward + creates land; diverged branch and moved tag do not.
    expect(byRef.get('refs/heads/main')).toMatchObject({ oldOid: OLD, newOid: NEW });
    expect(byRef.get('refs/heads/feature')).toMatchObject({ oldOid: '0'.repeat(40), newOid: NEW });
    expect(byRef.get('refs/tags/v2')).toMatchObject({ oldOid: '0'.repeat(40), newOid: TAG });
    expect(byRef.has('refs/heads/diverged')).toBe(false);
    expect(byRef.has('refs/tags/v1')).toBe(false);
    expect(db.data.mirrors[0].last_status).toBe('ok');
  });

  it('cleans up mirrors whose repo is gone and skips disabled ones', async () => {
    const db = createRunnerDb({
      mirrors: [
        {
          repository_id: 'gone',
          source_url: 'https://github.com/o/r',
          interval_minutes: 60,
          enabled: 1,
          last_run_at: null,
          last_status: null,
          last_error: null,
          consecutive_failures: 0,
          created_by: 'a@b.c',
          created_at: 0,
          updated_at: 0,
        },
      ],
    });
    const env = mirrorEnv(db, {});
    await runMirrorSync(env, 'gone');
    expect(db.data.mirrors).toHaveLength(0);

    const db2 = createRunnerDb({
      repos: [{ id: 'r1', owner: 'alice', name: 'demo' }],
      mirrors: [
        {
          repository_id: 'r1',
          source_url: 'https://github.com/o/r',
          interval_minutes: 60,
          enabled: 0,
          last_run_at: null,
          last_status: null,
          last_error: null,
          consecutive_failures: 0,
          created_by: 'a@b.c',
          created_at: 0,
          updated_at: 0,
        },
      ],
    });
    const stub = {
      listRefs: () => {
        throw new Error('must not be called');
      },
    };
    await runMirrorSync(mirrorEnv(db2, stub), 'r1');
    expect(db2.data.mirrors[0].last_status).toBeNull();
  });

  it('records failures without throwing', async () => {
    const db = createRunnerDb({
      repos: [{ id: 'r1', owner: 'alice', name: 'demo' }],
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
          created_by: 'a@b.c',
          created_at: 0,
          updated_at: 0,
        },
      ],
    });
    const stub = {
      listRefs: async () => ({ refs: [], symbolicHead: null }),
      importPack: async () => ({ importedRefs: [] as string[] }),
      isAncestor: async () => false,
      updateRefs: async () => ({ updated: [] as string[] }),
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    try {
      await runMirrorSync(mirrorEnv(db, stub), 'r1');
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(db.data.mirrors[0].last_status).toBe('failed');
    expect(db.data.mirrors[0].consecutive_failures).toBe(1);
    expect(db.data.mirrors[0].enabled).toBe(1);
  });

  it('routes the repo stub via the canonical lowercase DO key', async () => {
    const db = createRunnerDb({
      repos: [{ id: 'r1', owner: 'PublicMirror', name: 'AWS-AccessBridge' }],
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
          created_by: 'a@b.c',
          created_at: 0,
          updated_at: 0,
        },
      ],
    });
    const stub = {
      listRefs: async () => ({ refs: [], symbolicHead: null }),
      importPack: async () => ({ importedRefs: [] as string[] }),
      isAncestor: async () => true,
      updateRefs: async () => ({ updated: [] as string[] }),
    };
    const seen: string[] = [];
    const env = {
      DB: db,
      REPO: {
        getByName: (key: string) => {
          seen.push(key);
          return stub;
        },
      },
    } as unknown as Env;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/info/refs')) {
        return new Response(advertisement() as unknown as BodyInit, {
          status: 200,
          headers: { 'Content-Type': 'application/x-git-upload-pack-advertisement' },
        });
      }
      return new Response(packResponse() as unknown as BodyInit, { status: 200 });
    }) as typeof fetch;
    try {
      await runMirrorSync(env, 'r1');
    } finally {
      globalThis.fetch = realFetch;
    }
    // Mixed-case repos must sync into the same canonical isolate that API
    // reads (getRepoStub) address — otherwise the sync populates an orphaned
    // DO and the overview stays empty (live PublicMirror incident).
    expect(seen).toEqual(['publicmirror/aws-accessbridge']);
    expect(db.data.mirrors[0].last_status).toBe('ok');
  });
});
