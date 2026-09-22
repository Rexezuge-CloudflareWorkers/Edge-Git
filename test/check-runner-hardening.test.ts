import { describe, expect, it } from 'vitest';
import { runCustomCheckScript } from '@edge-git/background/checks/CustomJsSandbox';
import type { SandboxLimits } from '@edge-git/background/checks/CustomJsSandbox';
import { resolveSandboxLimits } from '@edge-git/background/checks/SandboxLimits';
import { parseCheckDefinitionFile } from '@edge-git/background/checks/CheckDefinition';
import { publishCheckLive } from '@edge-git/background/checks/CheckLivePublish';
import { getQuickJSModule } from '@edge-git/background/checks/quickjsLoader';
import { CheckRunnerWorker } from '@edge-git/background/checks/CheckRunnerWorker';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
import type { D1Queryable } from '@edge-git/backend-data/utils';

const LIMITS: SandboxLimits = {
  cpuMs: 3000,
  memoryMb: 16,
  maxFetches: 2,
  fetchTimeoutMs: 2000,
  maxResponseBytes: 65536,
  wallMs: 15000,
  maxLogBytes: 4096,
};

const FILES = { 'README.md': '# Hello', 'src/a.ts': 'export const x = 1;\n' };

async function run(script: string, overrides: Partial<Parameters<typeof runCustomCheckScript>[0]> = {}) {
  return runCustomCheckScript({ script, files: FILES, env: {}, allowHosts: [], limits: LIMITS, ...overrides });
}

function textBlob(text: string): { contentBase64: string; isBinary: boolean } {
  return { contentBase64: Buffer.from(text, 'utf8').toString('base64'), isBinary: false };
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

describe('check sandbox timeout enforcement', () => {
  it('times out infinite loops via the CPU budget', async () => {
    const result = await run('function main(ctx) { let i = 0; while (true) { i++; } }', {
      limits: { ...LIMITS, cpuMs: 400 },
    });
    expect(result.conclusion).toBe('timed_out');
    expect(result.title).toContain('Timed Out');
  });

  it('rejects async mains synchronously instead of hanging on the wall watchdog', async () => {
    const started = Date.now();
    const result = await run('async function main(ctx) { await ctx.listFiles(); return { conclusion: "success" }; }');
    expect(result.conclusion).toBe('failure');
    expect(result.summary).toContain('must be synchronous');
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('lets fast scripts settle even with a tiny wall budget (floor clamp)', async () => {
    const result = await run('function main(ctx) { return { conclusion: "success", title: "Fast", summary: "done" }; }', {
      limits: { ...LIMITS, wallMs: 50 },
    });
    expect(result.conclusion).toBe('success');
  });
});

describe('check sandbox memory cap', () => {
  it('contains huge allocations via memoryMb instead of crashing', async () => {
    const result = await run(
      'function main(ctx) { const s = "x".repeat(10000000); return { conclusion: "success", summary: String(s.length) }; }',
      {
        limits: { ...LIMITS, memoryMb: 4, cpuMs: 3000 },
      },
    );
    expect(result.conclusion).not.toBe('success');
    expect(['failure', 'timed_out', 'action_required']).toContain(result.conclusion);
  });

  it('resolveSandboxLimits defaults to injected config', () => {
    const limits = resolveSandboxLimits(AppConfiguration.fromEnv({} as never));
    expect(limits.cpuMs).toBe(5000);
    expect(limits.memoryMb).toBe(16);
    expect(limits.maxFetches).toBe(5);
    expect(limits.wallMs).toBe(3600 * 1000);
  });

  it('resolveSandboxLimits honors explicit overrides', () => {
    const limits = resolveSandboxLimits(AppConfiguration.fromEnv({} as never), { cpuMs: 250, memoryMb: 8, maxFetches: 1 });
    expect(limits.cpuMs).toBe(250);
    expect(limits.memoryMb).toBe(8);
    expect(limits.maxFetches).toBe(1);
  });
});

describe('check allowHosts SSRF guard', () => {
  it('rejects loopback and private literals in definitions', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254']) {
      expect(
        () =>
          parseCheckDefinitionFile(JSON.stringify({ checks: [{ context: 'lint', script: '.edgegit/checks/a.js', allowHosts: [host] }] })),
        host,
      ).toThrow(/loopback|private|reserved/);
    }
  });

  it('accepts and lowercases public hosts', () => {
    const checks = parseCheckDefinitionFile(
      JSON.stringify({ checks: [{ context: 'lint', script: '.edgegit/checks/a.js', allowHosts: ['Example.COM'] }] }),
    );
    expect(checks[0]?.allowHosts).toEqual(['example.com']);
  });

  it('blocks loopback literals even when allowlisted', async () => {
    const result = await run(
      'function main(ctx) { const r = ctx.fetch("https://127.0.0.1/x"); return { conclusion: "success", summary: String(r.status) }; }',
      { allowHosts: ['127.0.0.1'] },
    );
    expect(result.conclusion).toBe('failure');
    expect(result.summary).toMatch(/loopback|private|reserved/);
  });

  it('blocks carrier-grade and private literals when allowlisted', async () => {
    const result = await run(
      'function main(ctx) { const r = ctx.fetch("https://10.0.0.1/x"); return { conclusion: "success", summary: String(r.status) }; }',
      { allowHosts: ['10.0.0.1'] },
    );
    expect(result.conclusion).toBe('failure');
    expect(result.summary).toMatch(/loopback|private|reserved/);
  });

  it('blocks hosts outside allowHosts', async () => {
    const result = await run(
      'function main(ctx) { const r = ctx.fetch("https://example.com/x"); return { conclusion: "success", summary: String(r.status) }; }',
    );
    expect(result.conclusion).toBe('failure');
    expect(result.summary).toContain('not in allowHosts');
  });

  it('blocks non-https fetches', async () => {
    const result = await run(
      'function main(ctx) { const r = ctx.fetch("http://example.com/x"); return { conclusion: "success", summary: String(r.status) }; }',
      { allowHosts: ['example.com'] },
    );
    expect(result.conclusion).toBe('failure');
    expect(result.summary).toContain('must use https');
  });

  it('matches allowHosts case-insensitively for public hosts', async () => {
    const stub = withFetchStub(() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
    try {
      const result = await run(
        'function main(ctx) { const r = ctx.fetch("https://EXAMPLE.com/api"); return { conclusion: "success", summary: "status=" + r.status + " body=" + r.body }; }',
        { allowHosts: ['example.com'] },
      );
      expect(result.conclusion).toBe('success');
      expect(result.summary).toContain('status=200');
      expect(stub.calls).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  it('enforces the per-run fetch count cap', async () => {
    const stub = withFetchStub(() => new Response('ok', { status: 200 }));
    try {
      const result = await run(
        'function main(ctx) { ctx.fetch("https://example.com/a"); const r = ctx.fetch("https://example.com/b"); return { conclusion: "success", summary: String(r.status) }; }',
        { allowHosts: ['example.com'], limits: { ...LIMITS, maxFetches: 1 } },
      );
      expect(result.conclusion).toBe('failure');
      expect(result.summary).toContain('at most 1 fetches');
      expect(stub.calls).toHaveLength(1);
    } finally {
      stub.restore();
    }
  });

  it('caps captured logs to bound exfiltration volume', async () => {
    const result = await run(
      'function main(ctx) { for (let i = 0; i < 50; i++) { ctx.log("x".repeat(200)); } return { conclusion: "success" }; }',
      { limits: { ...LIMITS, maxLogBytes: 100 } },
    );
    expect(result.conclusion).toBe('success');
    expect(result.summary.length).toBeLessThanOrEqual(2000);
    expect(result.summary.match(/x{200}/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });
});

describe('check fork secret isolation', () => {
  it('exposes only declared env keys to untrusted scripts', async () => {
    const result = await run('function main(ctx) { return { conclusion: "success", summary: Object.keys(ctx.env).sort().join(",") }; }', {
      env: { LEVEL: 'strict', TOKEN: 'abc' },
    });
    expect(result.conclusion).toBe('success');
    expect(result.summary).toContain('LEVEL');
    expect(result.summary).toContain('TOKEN');
    expect(result.summary).not.toContain('AWS');
    expect(result.summary).not.toContain('GITHUB');
  });

  it('never auto-appends env secrets to the summary', async () => {
    const result = await run('function main(ctx) { return { conclusion: "success", summary: "clean" }; }', {
      env: { DEPLOY_KEY: 'super-secret-value-12345' },
    });
    expect(result.conclusion).toBe('success');
    expect(result.summary).not.toContain('super-secret-value-12345');
  });

  it('grants zero ambient host authority (no process/require)', async () => {
    const result = await run(
      'function main(ctx) { const ok = typeof process === "undefined" && typeof require === "undefined"; return { conclusion: ok ? "success" : "failure" }; }',
    );
    expect(result.conclusion).toBe('success');
  });

  it('sends only script-provided headers, never ambient credentials', async () => {
    const stub = withFetchStub(() => new Response('ok', { status: 200 }));
    try {
      const result = await run(
        'function main(ctx) { const r = ctx.fetch("https://example.com/a", { headers: { "X-Test": "1" } }); return { conclusion: "success", summary: "status=" + r.status }; }',
        { allowHosts: ['example.com'] },
      );
      expect(result.conclusion).toBe('success');
      const sent = (stub.calls[0]?.init?.headers ?? {}) as Record<string, string>;
      expect(sent['X-Test']).toBe('1');
      expect(sent['Authorization'] ?? sent['authorization']).toBeUndefined();
    } finally {
      stub.restore();
    }
  });

  it('keeps guest eval inside the sandbox (no host escape)', async () => {
    const result = await run(
      'function main(ctx) { const v = eval("40 + 2"); const ok = v === 42 && typeof process === "undefined"; return { conclusion: ok ? "success" : "failure" }; }',
    );
    expect(result.conclusion).toBe('success');
  });
});

describe('check live publish best-effort', () => {
  const ITEM = { headSha: 'a'.repeat(40), actorEmail: 'alice@example.com' };
  const RUN = { runId: 'run-1', context: 'secret-scan', conclusion: 'success', title: 'Clean' };

  it('resolves when no REALTIME binding exists', async () => {
    await expect(publishCheckLive({} as Env, 'alice/demo', ITEM, RUN)).resolves.toBeUndefined();
  });

  it('swallows publish rejections', async () => {
    const env = {
      REALTIME: {
        getByName: () => ({
          publish: async () => {
            throw new Error('down');
          },
        }),
      },
    } as unknown as Env;
    await expect(publishCheckLive(env, 'alice/demo', ITEM, RUN)).resolves.toBeUndefined();
  });

  it('swallows getByName throws', async () => {
    const env = {
      REALTIME: {
        getByName: () => {
          throw new Error('shard gone');
        },
      },
    } as unknown as Env;
    await expect(publishCheckLive(env, 'alice/demo', ITEM, RUN)).resolves.toBeUndefined();
  });

  it('skips invalid channels without publishing', async () => {
    let calls = 0;
    const env = {
      REALTIME: {
        getByName: () => ({
          publish: async () => {
            calls += 1;
          },
        }),
      },
    } as unknown as Env;
    await publishCheckLive(env, 'alice/demo', { headSha: 'not-a-sha!!', actorEmail: 'a@x.com' }, RUN);
    expect(calls).toBe(0);
  });

  it('publishes check_run.updated on the per-SHA channel', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const shards: string[] = [];
    const env = {
      REALTIME: {
        getByName: (shard: string) => {
          shards.push(shard);
          return {
            publish: async (input: Record<string, unknown>) => {
              seen.push(input);
            },
          };
        },
      },
    } as unknown as Env;
    await publishCheckLive(env, 'Alice/Demo', ITEM, { ...RUN, title: '' });
    expect(shards).toEqual(['repo:alice/demo']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ channel: `checks:${'a'.repeat(40)}`, type: 'check_run.updated', sha: 'a'.repeat(40) });
    expect(seen[0]?.title).toContain('secret-scan');
  });
});

describe('quickjs loader closed failure', () => {
  it('resolves the shared module via the fallback loader and memoizes it', async () => {
    const first = await getQuickJSModule();
    const second = await getQuickJSModule();
    expect(typeof (first as unknown as { newRuntime: unknown }).newRuntime).toBe('function');
    expect(second).toBe(first);
  });

  it('maps syntax errors to failure instead of escaping', async () => {
    const result = await run('function main(ctx) { {{{');
    expect(result.conclusion).toBe('failure');
  });
});

interface FakeStorage {
  map: Map<string, unknown>;
}

function fakeState(map: Map<string, unknown>) {
  return {
    storage: {
      get: (key: string) => Promise.resolve(map.get(key) ?? undefined),
      put: (key: string, value: unknown) => {
        map.set(key, value);
        return Promise.resolve();
      },
      setAlarm: () => Promise.resolve(),
    },
  } as unknown as DurableObjectState;
}

function createDoDb() {
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

function doEnv(db: D1Queryable) {
  const repoStub = {
    listAllFiles: async () => [{ path: 'README.md', oid: 'o'.repeat(40) }],
    getBlob: async () => textBlob('# hello'),
    getCommitDiff: async () => ({ files: [] }),
  };
  return { DB: db, REPO: { getByName: () => repoStub } } as unknown as Env;
}

describe('CheckRunnerWorker dispatch', () => {
  it('validates enqueue payloads over fetch', async () => {
    const { db } = createDoDb();
    const worker = new CheckRunnerWorker(fakeState(new Map()), doEnv(db));
    const bad = await worker.fetch(
      new Request('https://x/enqueue', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }),
    );
    expect(bad.status).toBe(400);
    const missing = await worker.fetch(new Request('https://x/nope'));
    expect(missing.status).toBe(404);
    const ok = await worker.fetch(
      new Request('https://x/enqueue', {
        method: 'POST',
        body: JSON.stringify({ repositoryId: 'repo-1', headSha: 'A'.repeat(40), contexts: ['secret-scan'], actorEmail: 'a@x.com' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });

  it('dedupes, trims, and caps enqueue contexts', async () => {
    const { db } = createDoDb();
    const map = new Map<string, unknown>();
    const worker = new CheckRunnerWorker(fakeState(map), doEnv(db));
    const queued = await worker.enqueueChecks({
      repositoryId: 'repo-1',
      headSha: 'a'.repeat(40),
      contexts: [' secret-scan ', 'secret-scan', '', 'diff-limit'],
      actorEmail: 'a@x.com',
    });
    expect(queued).toEqual({ queued: 2 });
    const pending = map.get('pending') as Array<{ contexts: string[] }>;
    expect(pending[0]?.contexts).toEqual(['secret-scan', 'diff-limit']);
    expect(
      await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: 'a'.repeat(40), contexts: ['  '], actorEmail: 'a@x.com' }),
    ).toEqual({ queued: 0 });
  });

  it('runs built-in secret-scan to a completed conclusion on alarm', async () => {
    const { db, checkRuns } = createDoDb();
    const map = new Map<string, unknown>();
    const worker = new CheckRunnerWorker(fakeState(map), doEnv(db));
    await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: 'a'.repeat(40), contexts: ['secret-scan'], actorEmail: 'a@x.com' });
    await worker.alarm();
    expect(checkRuns).toHaveLength(1);
    expect(checkRuns[0]).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(map.get('pending')).toEqual([]);
  });

  it('leaves custom contexts queued when no definition file exists', async () => {
    const { db, checkRuns } = createDoDb();
    const emptyStub = { listAllFiles: async () => [], getBlob: async () => null, getCommitDiff: async () => ({ files: [] }) };
    const env = { DB: db, REPO: { getByName: () => emptyStub } } as unknown as Env;
    const worker = new CheckRunnerWorker(fakeState(new Map()), env);
    await worker.enqueueChecks({ repositoryId: 'repo-1', headSha: 'b'.repeat(40), contexts: ['ci/external'], actorEmail: 'a@x.com' });
    await worker.alarm();
    expect(checkRuns).toHaveLength(0);
  });
});
