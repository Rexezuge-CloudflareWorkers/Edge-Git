import { describe, expect, it } from 'vitest';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import { runScheduledTasks } from '@edge-git/background/scheduled';
import { CronTasksWorker } from '@edge-git/background/CronTasksWorker';
import type { D1Queryable } from '@edge-git/backend-data/utils';

function createApiFakeDb() {
  const state = {
    repos: [] as Array<Record<string, unknown>>,
    tokens: [] as Array<Record<string, unknown>>,
    issues: [] as Array<Record<string, unknown>>,
    comments: [] as Array<Record<string, unknown>>,
    users: [] as Array<Record<string, unknown>>,
  };

  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM repositories WHERE owner = ? AND name = ?')) {
          return Promise.resolve((state.repos.find((r) => r.owner === params[0] && r.name === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM user_access_tokens WHERE token_hash = ?')) {
          return Promise.resolve(
            (state.tokens.find((t) => t.token_hash === params[0] && (t.expires_at as number) > (params[1] as number)) ?? null) as T | null,
          );
        }
        if (q.includes('FROM users WHERE email = ?')) {
          return Promise.resolve((state.users.find((u) => u.email === params[0]) ?? null) as T | null);
        }
        if (q.includes('COALESCE(MAX(number)')) {
          const max = state.issues.filter((i) => i.repository_id === params[0]).reduce((m, i) => Math.max(m, i.number as number), 0);
          return Promise.resolve({ max_n: max } as unknown as T);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM repositories WHERE owner_email = ?')) {
          return Promise.resolve({ results: state.repos.filter((r) => r.owner_email === params[0]) as T[] });
        }
        if (q.includes('FROM issues WHERE repository_id = ?')) {
          return Promise.resolve({
            results: state.issues
              .filter((i) => i.repository_id === params[0])
              .sort((a, b) => (b.number as number) - (a.number as number)) as T[],
          });
        }
        if (q.includes('FROM user_access_tokens WHERE user_email = ?')) {
          return Promise.resolve({ results: state.tokens.filter((t) => t.user_email === params[0]) as T[] });
        }
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO repositories')) {
          const [id, owner_email, owner, name, description, is_private, created_at, updated_at] = params as Array<string | number | null>;
          state.repos.push({ id, owner_email, owner, name, description, is_private, created_at, updated_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO user_access_tokens')) {
          const [token_id, user_email, token_hash, tname, expires_at, created_at] = params as Array<string | number>;
          state.tokens.push({ token_id, user_email, token_hash, name: tname, expires_at, last_used_at: null, created_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE user_access_tokens SET last_used_at')) {
          const row = state.tokens.find((t) => t.token_hash === params[1]);
          if (row) row.last_used_at = params[0];
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM user_access_tokens WHERE token_id = ?')) {
          state.tokens = state.tokens.filter((t) => !(t.token_id === params[0] && t.user_email === params[1]));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes('DELETE FROM user_access_tokens') && q.includes('expires_at < ?')) {
          const kept = state.tokens.filter((t) => !((t.expires_at as number) < (params[0] as number)));
          const pruned = state.tokens.length - kept.length;
          state.tokens.splice(0, state.tokens.length, ...kept);
          return Promise.resolve({ success: true, meta: { changes: pruned } });
        }
        if (q.startsWith('INSERT INTO issues')) {
          const [id, repository_id, full_name, number, title, body, status, creator_email, created_at, updated_at] = params as Array<
            string | number | null
          >;
          state.issues.push({ id, repository_id, full_name, number, title, body, status, creator_email, created_at, updated_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO users')) {
          const [email, created_at] = params as Array<string | number>;
          if (!state.users.some((u) => u.email === email)) state.users.push({ email, created_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        return Promise.resolve({ success: true, meta: { changes: 1 } });
      },
    };
  }

  const db = { ...state, prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) };
  return db as unknown as D1Queryable & typeof state;
}

function createStub() {
  return {
    setFullName: () => Promise.resolve(),
    ensureRepoInitialized: () => Promise.resolve(),
    listRefs: () => Promise.resolve({ refs: [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }], symbolicHead: 'refs/heads/main' }),
    getBranches: () => Promise.resolve({ branches: ['main'], currentBranch: 'main' }),
    getTree: () => Promise.resolve([]),
    getBlob: () => Promise.resolve(null),
    getCommits: () => Promise.resolve([]),
    fetch: () => Promise.resolve(new Response('PACK', { status: 200 })),
  };
}

function createEnv(db: D1Queryable) {
  const stub = createStub();
  return {
    DB: db,
    REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    CRON_TASKS: { get: () => stub, idFromName: (n: string) => n },
    DEV_AUTH_EMAIL: 'alice@example.com',
  };
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };

describe('EdgeGitWorker HTTP surface', () => {
  it('serves health, shell, and redirects', async () => {
    const worker = new EdgeGitWorker();
    const env = createEnv(createApiFakeDb());
    const onRequest = (worker as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> }).onRequest.bind(worker);
    const health = await onRequest(new Request('https://git.example.com/health'), env, ctx);
    expect(health.status).toBe(200);
    const root = await onRequest(new Request('https://git.example.com/'), env, ctx);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    const userRedirect = await onRequest(new Request('https://git.example.com/user'), env, ctx);
    expect(userRedirect.status).toBe(302);
  });

  it('manages repos, tokens, and issues for an authenticated user', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const db = createApiFakeDb();
    const env = createEnv(db);
    const call = (path: string, init?: RequestInit): Promise<Response> => worker.onRequest(new Request(`https://git.example.com${path}`, init), env, ctx);

    await expect(call('/user/me').then((r) => r.json())).resolves.toMatchObject({ email: 'alice@example.com' });

    const created = await call('/user/repos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'demo' }) });
    expect(created.status).toBe(201);
    await expect(call('/user/repos').then((r) => r.json())).resolves.toMatchObject({ repos: [{ name: 'demo' }] });
    expect((await call('/user/repos/alice/demo')).status).toBe(200);
    expect((await call('/user/repos/alice/missing')).status).toBe(404);

    const bad = await call('/user/repos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(bad.status).toBe(400);

    const minted = await call('/user/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'laptop' }),
    });
    expect(minted.status).toBe(201);
    const tokenList = (await (await call('/user/tokens')).json()) as { tokens: Array<{ tokenId: string }> };
    expect(tokenList.tokens).toHaveLength(1);
    expect((await call(`/user/tokens/${tokenList.tokens[0].tokenId}`, { method: 'DELETE' })).status).toBe(200);

    const issue = await call('/user/repos/alice/demo/issues', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Bug' }),
    });
    expect(issue.status).toBe(201);
    await expect(call('/user/repos/alice/demo/issues').then((r) => r.json())).resolves.toMatchObject({ issues: [{ title: 'Bug' }] });

    await expect(call('/user/repos/alice/demo/branches').then((r) => r.json())).resolves.toMatchObject({ branches: ['main'] });
    expect((await call('/user/repos/alice/demo/tree')).status).toBe(200);
    expect((await call('/user/repos/alice/demo/blob?path=f.txt')).status).toBe(200);
    expect((await call('/user/repos/alice/demo/commits')).status).toBe(200);
  });

  it('serves git smart-http anonymously for public repos', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const db = createApiFakeDb();
    const env = createEnv(db);
    await worker.onRequest(
      new Request('https://git.example.com/user/repos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'pub' }) }),
      env,
      ctx,
    );
    const refs = await worker.onRequest(new Request('https://git.example.com/alice/pub/info/refs?service=git-upload-pack'), env, ctx);
    expect(refs.status).toBe(200);
    expect((await worker.onRequest(new Request('https://git.example.com/alice/pub/info/refs?service=nope'), env, ctx)).status).toBe(400);
    expect((await worker.onRequest(new Request('https://git.example.com/alice/pub/info/refs?service=git-receive-pack'), env, ctx)).status).toBe(401);
    expect((await worker.onRequest(new Request('https://git.example.com/alice/missing/info/refs?service=git-upload-pack'), env, ctx)).status).toBe(401);
    const pack = await worker.onRequest(new Request('https://git.example.com/alice/pub/git-upload-pack', { method: 'POST', body: new Uint8Array([1]) }), env, ctx);
    expect(pack.status).toBe(200);
  });

  it('serves the SPA catch-all under /user/', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const env = createEnv(createApiFakeDb());
    expect((await worker.onRequest(new Request('https://git.example.com/user/unknown-route'), env, ctx)).status).toBe(200);
  });

  it('serves public repo reads anonymously and gates private repos', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const db = createApiFakeDb();
    const authedEnv = createEnv(db);
    const anonEnv = { ...authedEnv, DEV_AUTH_EMAIL: undefined };
    const authed = (path: string, init?: RequestInit): Promise<Response> =>
      worker.onRequest(new Request(`https://git.example.com${path}`, init), authedEnv, ctx);
    const anon = (path: string, init?: RequestInit): Promise<Response> =>
      worker.onRequest(new Request(`https://git.example.com${path}`, init), anonEnv, ctx);

    const json = { 'Content-Type': 'application/json' };
    expect((await authed('/user/repos', { method: 'POST', headers: json, body: JSON.stringify({ name: 'pub' }) })).status).toBe(201);
    expect(
      (await authed('/user/repos', { method: 'POST', headers: json, body: JSON.stringify({ name: 'sec', isPrivate: true }) })).status,
    ).toBe(201);

    for (const path of ['/repos/alice/pub', '/repos/alice/pub/branches', '/repos/alice/pub/tree', '/repos/alice/pub/commits', '/repos/alice/pub/issues']) {
      expect(await anon(path).then((r) => r.status)).toBe(200);
    }
    expect(await anon('/repos/alice/pub/blob?path=f.txt').then((r) => r.status)).toBe(200);

    expect(await anon('/repos/alice/sec').then((r) => r.status)).toBe(404);
    expect(await anon('/repos/alice/sec/branches').then((r) => r.status)).toBe(404);
    expect(await anon('/repos/alice/missing').then((r) => r.status)).toBe(404);

    expect(await authed('/repos/alice/sec').then((r) => r.status)).toBe(200);
  });

  it('serves the repo-home shell for owner/repo paths without shadowing git', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const db = createApiFakeDb();
    const authedEnv = createEnv(db);
    const anonEnv = { ...authedEnv, DEV_AUTH_EMAIL: undefined };
    await worker.onRequest(
      new Request('https://git.example.com/user/repos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'pub' }) }),
      authedEnv,
      ctx,
    );
    const shell = await worker.onRequest(new Request('https://git.example.com/alice/pub'), anonEnv, ctx);
    expect(shell.status).toBe(200);
    expect(shell.headers.get('content-type')).toContain('text/html');
    // Git smart-http still takes precedence on its exact paths.
    const refs = await worker.onRequest(new Request('https://git.example.com/alice/pub/info/refs?service=git-upload-pack'), anonEnv, ctx);
    expect(refs.status).toBe(200);
    expect(refs.headers.get('content-type')).not.toContain('text/html');
  });
});

describe('scheduled tasks', () => {
  it('prunes expired tokens', async () => {
    const db = createApiFakeDb();
    const env = { DB: db } as unknown as Env;
    const svc = (await import('@edge-git/backend-services/auth')).TokenServiceFactory.create({ DB: db });
    await svc.createToken('a@x.co', 't1');
    db.tokens.push({ token_id: 'old', user_email: 'a@x.co', token_hash: 'h', name: 'old', expires_at: 1, last_used_at: null, created_at: 1 });
    await runScheduledTasks(env, '*/10 * * * *', Date.now());
    expect(db.tokens.some((t) => t.token_id === 'old')).toBe(false);
  });

  it('CronTasksWorker runs and rejects unknown routes', async () => {
    const db = createApiFakeDb();
    const env = { DB: db } as unknown as Env;
    const worker = new CronTasksWorker({} as never, env);
    const ok = await worker.fetch(new Request('https://do/run', { method: 'POST', body: '{}' }));
    expect([200, 202]).toContain(ok.status);
    expect((await worker.fetch(new Request('https://do/nope'))).status).toBe(404);
  });
});
