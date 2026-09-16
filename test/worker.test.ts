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
        if (q.includes('FROM repositories WHERE id = ?')) {
          return Promise.resolve((state.repos.find((r) => r.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM user_access_tokens WHERE token_hash = ?')) {
          return Promise.resolve(
            (state.tokens.find((t) => t.token_hash === params[0] && (t.expires_at as number) > (params[1] as number)) ?? null) as T | null,
          );
        }
        if (q.includes('FROM users WHERE email = ?') || q.includes('FROM users WHERE lower(email)')) {
          return Promise.resolve((state.users.find((u) => String(u.email).toLowerCase() === String(params[0]).toLowerCase()) ?? null) as T | null);
        }
        if (q.includes('COALESCE(MAX(number)')) {
          const max = state.issues.filter((i) => i.repository_id === params[0]).reduce((m, i) => Math.max(m, i.number as number), 0);
          return Promise.resolve({ max_n: max } as unknown as T);
        }
        if (q.includes('FROM issues WHERE repository_id = ? AND number = ?')) {
          return Promise.resolve(
            (state.issues.find((i) => i.repository_id === params[0] && i.number === params[1]) ?? null) as T | null,
          );
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM repositories WHERE owner_email = ?') || q.includes('FROM repositories WHERE lower(owner_email)')) {
          return Promise.resolve({ results: state.repos.filter((r) => String(r.owner_email).toLowerCase() === String(params[0]).toLowerCase()) as T[] });
        }
        if (q.includes('FROM issues WHERE repository_id = ?')) {
          return Promise.resolve({
            results: state.issues
              .filter((i) => i.repository_id === params[0])
              .sort((a, b) => (b.number as number) - (a.number as number)) as T[],
          });
        }
        if (q.includes('FROM comments WHERE issue_id = ?')) {
          return Promise.resolve({
            results: state.comments
              .filter((c) => c.issue_id === params[0])
              .sort((a, b) => (a.created_at as number) - (b.created_at as number)) as T[],
          });
        }
        if (q.includes('FROM user_access_tokens WHERE') && q.includes('user_email')) {
          return Promise.resolve({
            results: state.tokens.filter((t) => String(t.user_email).toLowerCase() === String(params[0]).toLowerCase()) as T[],
          });
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
          state.tokens = state.tokens.filter(
            (t) => !(t.token_id === params[0] && String(t.user_email).toLowerCase() === String(params[1]).toLowerCase()),
          );
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
        if (q.startsWith('UPDATE issues SET status = ?')) {
          const [status, updated_at, id] = params as Array<string | number>;
          const row = state.issues.find((i) => i.id === id);
          if (row) {
            row.status = status;
            row.updated_at = updated_at;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO comments')) {
          const [id, issue_id, author_email, body, created_at] = params as Array<string | number>;
          state.comments.push({ id, issue_id, author_email, body, created_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO users')) {
          const [email, created_at] = params as Array<string | number>;
          if (!state.users.some((u) => u.email === email)) state.users.push({ email, created_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE repositories SET')) {
          const id = params[params.length - 1] as string;
          const row = state.repos.find((r) => r.id === id);
          if (row) {
            let idx = 1;
            row.updated_at = params[0];
            if (q.includes('description = ?')) row.description = params[idx++] as string | null;
            if (q.includes('is_private = ?')) row.is_private = params[idx++] as number;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM comments WHERE issue_id IN')) {
          const repoId = params[0] as string;
          const issueIds = new Set(state.issues.filter((i) => i.repository_id === repoId).map((i) => i.id));
          const keptComments = state.comments.filter((cm) => !issueIds.has(cm.issue_id));
          state.comments.splice(0, state.comments.length, ...keptComments);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM issues WHERE repository_id = ?')) {
          const keptIssues = state.issues.filter((i) => i.repository_id !== params[0]);
          state.issues.splice(0, state.issues.length, ...keptIssues);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repositories WHERE id = ?')) {
          const keptRepos = state.repos.filter((r) => r.id !== params[0]);
          state.repos.splice(0, state.repos.length, ...keptRepos);
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
    deleteRepo: () => Promise.resolve(),
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

  it('updates and deletes repos as owner only, purging issues', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const db = createApiFakeDb();
    const env = createEnv(db);
    const bobEnv = { ...env, DEV_AUTH_EMAIL: 'bob@example.com' };
    const json = { 'Content-Type': 'application/json' };
    const call = (path: string, init?: RequestInit): Promise<Response> => worker.onRequest(new Request(`https://git.example.com${path}`, init), env, ctx);
    const callAsBob = (path: string, init?: RequestInit): Promise<Response> =>
      worker.onRequest(new Request(`https://git.example.com${path}`, init), bobEnv, ctx);

    expect((await call('/user/repos', { method: 'POST', headers: json, body: JSON.stringify({ name: 'mine' }) })).status).toBe(201);

    const patched = await call('/user/repos/alice/mine', {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ description: 'Hello', isPrivate: true }),
    });
    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toMatchObject({ description: 'Hello', isPrivate: true, viewerCanManage: true });

    expect((await call('/user/repos/alice/mine', { method: 'PATCH', headers: json, body: JSON.stringify({}) })).status).toBe(400);
    expect(
      (await call('/user/repos/alice/mine', { method: 'PATCH', headers: json, body: JSON.stringify({ description: 'x'.repeat(501) }) })).status,
    ).toBe(400);
    expect((await call('/user/repos/alice/missing', { method: 'PATCH', headers: json, body: JSON.stringify({ description: 'y' }) })).status).toBe(
      404,
    );

    expect((await callAsBob('/user/repos/alice/mine', { method: 'PATCH', headers: json, body: JSON.stringify({ description: 'hijack' }) })).status).toBe(
      404,
    );
    expect((await call('/user/repos', { method: 'POST', headers: json, body: JSON.stringify({ name: 'ours' }) })).status).toBe(201);
    await expect(callAsBob('/user/repos/alice/ours').then((r) => r.json())).resolves.toMatchObject({ viewerCanManage: false });
    // Public repo reveals existence: non-admin gets 403 on write.
    expect((await callAsBob('/user/repos/alice/ours', { method: 'PATCH', headers: json, body: JSON.stringify({ description: 'hijack' }) })).status).toBe(
      403,
    );
    // Private repo hides existence from outsiders.
    expect((await callAsBob('/user/repos/alice/mine', { method: 'DELETE' })).status).toBe(404);

    expect(
      (await call('/user/repos/alice/mine/issues', { method: 'POST', headers: json, body: JSON.stringify({ title: 'Gone' }) })).status,
    ).toBe(201);

    const deleted = await call('/user/repos/alice/mine', { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await call('/user/repos/alice/mine')).status).toBe(404);
    expect(db.issues).toHaveLength(0);
    expect((await call('/user/repos/alice/mine', { method: 'DELETE' })).status).toBe(404);
  });

  it('reads, closes, and comments on individual issues', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const db = createApiFakeDb();
    const env = createEnv(db);
    const bobEnv = { ...env, DEV_AUTH_EMAIL: 'bob@example.com' };
    const anonEnv = { ...env, DEV_AUTH_EMAIL: undefined };
    const json = { 'Content-Type': 'application/json' };
    const call = (path: string, init?: RequestInit): Promise<Response> => worker.onRequest(new Request(`https://git.example.com${path}`, init), env, ctx);
    const callAsBob = (path: string, init?: RequestInit): Promise<Response> =>
      worker.onRequest(new Request(`https://git.example.com${path}`, init), bobEnv, ctx);
    const callAnon = (path: string, init?: RequestInit): Promise<Response> =>
      worker.onRequest(new Request(`https://git.example.com${path}`, init), anonEnv, ctx);

    expect((await call('/user/repos', { method: 'POST', headers: json, body: JSON.stringify({ name: 'demo' }) })).status).toBe(201);
    expect(
      (await call('/user/repos/alice/demo/issues', { method: 'POST', headers: json, body: JSON.stringify({ title: 'Bug', body: '**bold**' }) }))
        .status,
    ).toBe(201);

    await expect(call('/user/repos/alice/demo/issues/1').then((r) => r.json())).resolves.toMatchObject({ issue: { number: 1 } });
    await expect(callAnon('/repos/alice/demo/issues/1').then((r) => r.json())).resolves.toMatchObject({ issue: { number: 1 } });
    expect((await call('/user/repos/alice/demo/issues/99')).status).toBe(404);
    expect((await callAnon('/repos/alice/demo/issues/99')).status).toBe(404);
    expect((await callAnon('/repos/alice/missing/issues/1')).status).toBe(404);

    const comment = await call('/user/repos/alice/demo/issues/1/comments', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ body: '  first  ' }),
    });
    expect(comment.status).toBe(201);
    await expect(call('/user/repos/alice/demo/issues/1/comments').then((r) => r.json())).resolves.toMatchObject({
      comments: [{ body: 'first' }],
    });
    await expect(callAnon('/repos/alice/demo/issues/1/comments').then((r) => r.json())).resolves.toMatchObject({
      comments: [{ body: 'first' }],
    });
    expect(
      (await call('/user/repos/alice/demo/issues/1/comments', { method: 'POST', headers: json, body: JSON.stringify({ body: '   ' }) })).status,
    ).toBe(400);
    expect((await call('/user/repos/alice/demo/issues/99/comments', { method: 'POST', headers: json, body: JSON.stringify({ body: 'x' }) })).status).toBe(
      404,
    );

    const closed = await call('/user/repos/alice/demo/issues/1', { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'closed' }) });
    expect(closed.status).toBe(200);
    await expect(closed.json()).resolves.toMatchObject({ issue: { status: 'closed' } });
    await expect(callAnon('/repos/alice/demo/issues/1').then((r) => r.json())).resolves.toMatchObject({ issue: { status: 'closed' } });
    const reopened = await call('/user/repos/alice/demo/issues/1', { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'open' }) });
    expect(reopened.status).toBe(200);

    expect((await call('/user/repos/alice/demo/issues/1', { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'bogus' }) })).status).toBe(
      400,
    );
    expect((await call('/user/repos/alice/demo/issues/99', { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'closed' }) })).status).toBe(
      404,
    );
    expect(
      (await callAsBob('/user/repos/alice/demo/issues/1', { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'closed' }) })).status,
    ).toBe(403);
  });

  it('serves the SPA shell for /settings and /new', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const env = createEnv(createApiFakeDb());
    for (const path of ['/settings', '/new', '/user/unknown-route']) {
      const res = await worker.onRequest(new Request(`https://git.example.com${path}`), env, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    }
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

  it('serves the SPA shell for individual issue paths', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const db = createApiFakeDb();
    const authedEnv = createEnv(db);
    const anonEnv = { ...authedEnv, DEV_AUTH_EMAIL: undefined };
    await worker.onRequest(
      new Request('https://git.example.com/user/repos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'pub' }) }),
      authedEnv,
      ctx,
    );
    const shell = await worker.onRequest(new Request('https://git.example.com/alice/pub/issues/1'), anonEnv, ctx);
    expect(shell.status).toBe(200);
    expect(shell.headers.get('content-type')).toContain('text/html');

    const noServeEnv = { ...anonEnv, SERVE_SPA_FROM_WORKER: 'false' };
    const gated = await worker.onRequest(new Request('https://git.example.com/alice/pub/issues/1'), noServeEnv, ctx);
    expect(gated.status).toBe(404);

    const tooDeep = await worker.onRequest(new Request('https://git.example.com/alice/pub/issues/1/extra'), anonEnv, ctx);
    expect(tooDeep.status).toBe(404);
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
