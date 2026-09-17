import { describe, expect, it } from 'vitest';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import type { D1Queryable } from '@edge-git/backend-data/utils';

const ALICE = 'alice@example.com';

function createTransferFakeDb() {
  const state = {
    users: [{ email: ALICE, username: 'alice', created_at: 0, updated_at: 0 }] as Array<Record<string, unknown>>,
    namespaces: [{ username_ci: 'alice', kind: 'user', user_email: ALICE, org_id: null }] as Array<Record<string, unknown>>,
    repos: [
      { id: 'repo-empty', owner_email: ALICE, owner: 'alice', name: 'empty', description: null, is_private: 0, created_at: 0, updated_at: 0, owner_type: 'user', owner_ci: 'alice', name_ci: 'empty', owner_user_email: ALICE, org_id: null },
      { id: 'repo-full', owner_email: ALICE, owner: 'alice', name: 'full', description: null, is_private: 1, created_at: 0, updated_at: 0, owner_type: 'user', owner_ci: 'alice', name_ci: 'full', owner_user_email: ALICE, org_id: null },
    ] as Array<Record<string, unknown>>,
    tokens: [] as Array<Record<string, unknown>>,
    grants: [] as Array<Record<string, unknown>>,
    imports: [] as Array<Record<string, unknown>>,
    mirrors: [] as Array<Record<string, unknown>>,
    keys: [] as Array<Record<string, unknown>>,
    security: [] as Array<Record<string, unknown>>,
  };

  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM users WHERE lower(email)')) {
          return Promise.resolve((state.users.find((u) => String(u.email).toLowerCase() === String(params[0]).toLowerCase()) ?? null) as T | null);
        }
        if (q.includes('FROM namespaces WHERE username_ci = ?')) {
          return Promise.resolve((state.namespaces.find((n) => n.username_ci === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE lower(owner) = ? AND lower(name) = ?')) {
          return Promise.resolve(
            (state.repos.find((r) => String(r.owner).toLowerCase() === String(params[0]).toLowerCase() && String(r.name).toLowerCase() === String(params[1]).toLowerCase()) ?? null) as T | null,
          );
        }
        if (q.includes('FROM repositories WHERE id = ?')) {
          return Promise.resolve((state.repos.find((r) => r.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM user_access_tokens WHERE token_hash = ?')) {
          return Promise.resolve((state.tokens.find((t) => t.token_hash === params[0] && (t.expires_at as number) > (params[1] as number)) ?? null) as T | null);
        }
        if (q.includes('FROM repo_imports WHERE repository_id = ? ORDER BY')) {
          const rows = state.imports.filter((i) => i.repository_id === params[0]).sort((a, b) => (b.created_at as number) - (a.created_at as number));
          return Promise.resolve((rows[0] ?? null) as T | null);
        }
        if (q.includes('FROM repo_imports WHERE repository_id = ? AND status IN')) {
          return Promise.resolve((state.imports.find((i) => i.repository_id === params[0] && ['pending', 'running'].includes(i.status as string)) ?? null) as T | null);
        }
        if (q.includes('FROM repo_imports WHERE id = ?')) {
          return Promise.resolve((state.imports.find((i) => i.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM repo_mirrors WHERE repository_id = ?')) {
          return Promise.resolve((state.mirrors.find((m) => m.repository_id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM deploy_keys WHERE token_hash = ?')) {
          return Promise.resolve((state.keys.find((k) => k.token_hash === params[0] && (k.expires_at as number) > (params[1] as number)) ?? null) as T | null);
        }
        if (q.includes('FROM deploy_keys WHERE id = ? AND repository_id = ?')) {
          return Promise.resolve((state.keys.find((k) => k.id === params[0] && k.repository_id === params[1]) ?? null) as T | null);
        }
        if (q.includes('COUNT(*) AS n FROM deploy_keys')) {
          return Promise.resolve({ n: state.keys.filter((k) => k.repository_id === params[0]).length } as unknown as T);
        }
        if (q.includes('FROM repo_security_settings WHERE repository_id = ?')) {
          return Promise.resolve((state.security.find((s) => s.repository_id === params[0]) ?? null) as T | null);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM user_access_tokens WHERE') && q.includes('user_email')) {
          return Promise.resolve({ results: state.tokens.filter((t) => String(t.user_email).toLowerCase() === String(params[0]).toLowerCase()) as T[] });
        }
        if (q.includes('FROM token_repo_grants WHERE token_id = ?')) {
          return Promise.resolve({ results: state.grants.filter((g) => g.token_id === params[0]) as T[] });
        }
        if (q.includes('FROM deploy_keys WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.keys.filter((k) => k.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM repositories WHERE') && q.includes('owner_email')) {
          return Promise.resolve({ results: state.repos.filter((r) => String(r.owner_email).toLowerCase() === String(params[0]).toLowerCase()) as T[] });
        }
        if (q.includes('FROM repositories WHERE lower(owner) = ?')) {
          return Promise.resolve({ results: state.repos.filter((r) => String(r.owner).toLowerCase() === String(params[0]).toLowerCase()) as T[] });
        }
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO users')) {
          if (!state.users.some((u) => u.email === params[0])) state.users.push({ email: params[0], created_at: params[1] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE users SET')) {
          const row = state.users.find((u) => String(u.email).toLowerCase() === String(params[params.length - 1]).toLowerCase());
          if (row && !row.username) row.username = params[0];
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO user_access_tokens')) {
          const [token_id, user_email, token_hash, name, expires_at, created_at, scopes, token_prefix] = params as Array<string | number | null>;
          state.tokens.push({ token_id, user_email, token_hash, name, expires_at, last_used_at: null, created_at, scopes: typeof scopes === 'string' ? scopes : null, token_prefix: (token_prefix as string | null) ?? null });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE user_access_tokens SET token_hash')) {
          const row = state.tokens.find((t) => t.token_id === params[3] && String(t.user_email).toLowerCase() === String(params[4]).toLowerCase());
          if (row) {
            row.token_hash = params[0];
            row.token_prefix = params[1];
            row.expires_at = params[2];
            return Promise.resolve({ success: true, meta: { changes: 1 } });
          }
          return Promise.resolve({ success: true, meta: { changes: 0 } });
        }
        if (q.startsWith('DELETE FROM token_repo_grants WHERE token_id = ?')) {
          state.grants = state.grants.filter((g) => g.token_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO token_repo_grants')) {
          state.grants.push({ token_id: params[0], repository_id: params[1], scope: params[2], created_at: params[3] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO repo_imports')) {
          state.imports.push({ id: params[0], repository_id: params[1], source_url: params[2], status: params[3], error: null, refs_json: null, imported_refs: 0, created_by: params[4], created_at: params[5], updated_at: params[6] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith("UPDATE repo_imports SET status = 'running'")) {
          const row = state.imports.find((i) => i.id === params[1] && ['pending', 'running'].includes(i.status as string));
          if (row) {
            row.status = 'running';
            row.updated_at = params[0];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith("UPDATE repo_imports SET status = 'cancelled'")) {
          const row = state.imports.find((i) => i.id === params[1] && ['pending', 'running'].includes(i.status as string));
          if (row) {
            row.status = 'cancelled';
            row.updated_at = params[0];
            return Promise.resolve({ success: true, meta: { changes: 1 } });
          }
          return Promise.resolve({ success: true, meta: { changes: 0 } });
        }
        if (q.startsWith('INSERT INTO repo_mirrors')) {
          const existing = state.mirrors.find((m) => m.repository_id === params[0]);
          if (existing) {
            existing.source_url = params[1];
            existing.interval_minutes = params[2];
            existing.enabled = 1;
            existing.updated_at = params[6];
          } else {
            state.mirrors.push({ repository_id: params[0], source_url: params[1], interval_minutes: params[2], enabled: 1, last_run_at: null, last_status: null, last_error: null, consecutive_failures: 0, created_by: params[3], created_at: params[4], updated_at: params[5] });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE repo_mirrors SET enabled = ?')) {
          const row = state.mirrors.find((m) => m.repository_id === params[2]);
          if (row) {
            row.enabled = params[0];
            row.consecutive_failures = 0;
            row.updated_at = params[1];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repo_mirrors')) {
          state.mirrors = state.mirrors.filter((m) => m.repository_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO deploy_keys')) {
          state.keys.push({ id: params[0], repository_id: params[1], name: params[2], token_hash: params[3], token_prefix: params[4], permission: params[5], expires_at: params[6], last_used_at: null, created_by: params[7], created_at: params[8] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE deploy_keys SET last_used_at')) {
          const row = state.keys.find((k) => k.token_hash === params[1]);
          if (row) row.last_used_at = params[0];
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM deploy_keys WHERE id = ?')) {
          state.keys = state.keys.filter((k) => !(k.id === params[0] && k.repository_id === params[1]));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO repo_security_settings')) {
          const existing = state.security.find((s) => s.repository_id === params[0]);
          if (existing) {
            existing.secret_scan_mode = params[1];
            existing.updated_by = params[2];
            existing.updated_at = params[3];
          } else {
            state.security.push({ repository_id: params[0], secret_scan_mode: params[1], updated_by: params[2], updated_at: params[3] });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      },
    };
  }
  return { prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }), state } as unknown as D1Queryable & { state: typeof state };
}

function createStub(empty: boolean) {
  return {
    setFullName: () => Promise.resolve(),
    ensureRepoInitialized: () => Promise.resolve(),
    listRefs: () => Promise.resolve({ refs: empty ? [] : [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }], symbolicHead: 'refs/heads/main' }),
    exportPack: () => Promise.resolve({ oids: ['a'.repeat(40)], pack: new Uint8Array([1, 2, 3]) }),
    importPack: () => Promise.resolve({ importedRefs: ['refs/heads/main'] }),
    receivePack: () => Promise.resolve(new Response('ok')),
    fetch: () => Promise.resolve(new Response('PACK', { status: 200 })),
  };
}

function createEnv(db: D1Queryable, empty: boolean) {
  const stub = createStub(empty);
  return {
    DB: db,
    REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    CRON_TASKS: { get: () => stub, idFromName: (n: string) => n },
    DEV_AUTH_EMAIL: ALICE,
  };
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };

describe('transfer + hardening routes', () => {
  it('runs the import lifecycle and refuses bad URLs', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const env = createEnv(createTransferFakeDb(), true);
    const call = (path: string, init?: RequestInit): Promise<Response> => worker.onRequest(new Request(`https://git.example.com${path}`, init), env, ctx);
    const post = (path: string, body: unknown): Promise<Response> =>
      call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    expect((await post('/user/repos/alice/empty/import', { sourceUrl: 'http://evil.local/x' })).status).toBe(400);
    expect((await post('/user/repos/alice/empty/import', {})).status).toBe(400);
    const started = await post('/user/repos/alice/empty/import', { sourceUrl: 'https://github.com/o/r' });
    expect(started.status).toBe(202);
    const created = (await started.json()) as { job: { id: string; status: string } };
    expect(created.job.status).toBe('pending');
    // Second concurrent import is rejected.
    expect((await post('/user/repos/alice/empty/import', { sourceUrl: 'https://github.com/o/other' })).status).toBe(400);

    const current = (await (await call('/user/repos/alice/empty/import')).json()) as { job: { id: string } };
    expect(current.job.id).toBe(created.job.id);
    expect((await call('/user/repos/alice/empty/import/xxx/cancel', { method: 'POST' })).status).toBe(404);
    const cancelled = await call(`/user/repos/alice/empty/import/${created.job.id}/cancel`, { method: 'POST' });
    expect(cancelled.status).toBe(200);
    await expect(cancelled.json()).resolves.toMatchObject({ job: { status: 'cancelled' } });
  });

  it('exports refs and fails closed on empty repos', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const emptyEnv = createEnv(createTransferFakeDb(), true);
    const fullEnv = createEnv(createTransferFakeDb(), false);
    const callEmpty = (path: string): Promise<Response> => worker.onRequest(new Request(`https://git.example.com${path}`), emptyEnv, ctx);
    const callFull = (path: string): Promise<Response> => worker.onRequest(new Request(`https://git.example.com${path}`), fullEnv, ctx);
    expect((await callEmpty('/user/repos/alice/empty/export')).status).toBe(404);
    const exported = await callFull('/user/repos/alice/full/export');
    expect(exported.status).toBe(200);
    await expect(exported.json()).resolves.toMatchObject({ refs: [{ ref: 'refs/heads/main' }], byteLength: 3 });
  });

  it('configures, reads, toggles, and removes mirrors', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const env = createEnv(createTransferFakeDb(), true);
    const call = (path: string, init?: RequestInit): Promise<Response> => worker.onRequest(new Request(`https://git.example.com${path}`, init), env, ctx);
    const put = (body: unknown): Promise<Response> =>
      call('/user/repos/alice/empty/mirror', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    expect((await put({ sourceUrl: 'https://github.com/o/r', intervalMinutes: 61 })).status).toBe(400);
    expect((await put({ sourceUrl: 'https://10.0.0.1/r', intervalMinutes: 60 })).status).toBe(400);
    expect((await put({ sourceUrl: 'https://github.com/o/r', intervalMinutes: 360 })).status).toBe(200);
    await expect(call('/user/repos/alice/empty/mirror').then((r) => r.json())).resolves.toMatchObject({ mirror: { intervalMinutes: 360, enabled: true } });
    await expect(
      call('/user/repos/alice/empty/mirror/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) }).then((r) => r.json()),
    ).resolves.toMatchObject({ mirror: { enabled: false } });
    expect((await call('/user/repos/alice/empty/mirror', { method: 'DELETE' })).status).toBe(200);
    expect((await call('/user/repos/alice/empty/mirror')).status).toBe(404);
  });

  it('manages deploy keys and honors them on git fetch', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const env = createEnv(createTransferFakeDb(), true);
    const call = (path: string, init?: RequestInit): Promise<Response> => worker.onRequest(new Request(`https://git.example.com${path}`, init), env, ctx);

    const created = (await (
      await call('/user/repos/alice/full/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ci', permission: 'read' }) })
    ).json()) as { id: string; key: string; prefix: string };
    expect(created.key.length).toBeGreaterThan(10);
    await expect(call('/user/repos/alice/full/keys').then((r) => r.json())).resolves.toMatchObject({ keys: [{ id: created.id }] });

    const fetchPath = '/alice/full/info/refs?service=git-upload-pack';
    expect((await call(fetchPath)).status).toBe(401);
    expect((await call(fetchPath, { headers: { Authorization: `Bearer ${created.key}` } })).status).toBe(200);
    expect((await call('/alice/full/info/refs?service=git-receive-pack', { headers: { Authorization: `Bearer ${created.key}` } })).status).toBe(401);

    expect((await call(`/user/repos/alice/full/keys/${created.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(fetchPath, { headers: { Authorization: `Bearer ${created.key}` } })).status).toBe(401);
  });

  it('reads and updates secret-scan mode', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const env = createEnv(createTransferFakeDb(), true);
    const call = (path: string, init?: RequestInit): Promise<Response> => worker.onRequest(new Request(`https://git.example.com${path}`, init), env, ctx);

    await expect(call('/user/repos/alice/empty/security').then((r) => r.json())).resolves.toMatchObject({ settings: { secretScanMode: 'warn' } });
    expect((await call('/user/repos/alice/empty/security', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secretScanMode: 'nope' }) })).status).toBe(400);
    await expect(
      call('/user/repos/alice/empty/security', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secretScanMode: 'block' }) }).then((r) => r.json()),
    ).resolves.toMatchObject({ settings: { secretScanMode: 'block' } });
  });

  it('rotates tokens and scopes them to repos', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const env = createEnv(createTransferFakeDb(), true);
    const call = (path: string, init?: RequestInit): Promise<Response> => worker.onRequest(new Request(`https://git.example.com${path}`, init), env, ctx);
    const post = (path: string, body: unknown): Promise<Response> =>
      call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const minted = (await (await post('/user/tokens', { name: 'scoped', repoGrants: [{ owner: 'alice', name: 'full', scope: 'repo:read' }] })).json()) as {
      tokenId: string;
      token: string;
      prefix: string;
    };
    expect(minted.prefix).toBe(minted.token.slice(0, 12));
    expect((await post('/user/tokens', { name: 'bad', repoGrants: [{ owner: 'alice', name: 'missing', scope: 'repo:read' }] })).status).toBe(404);

    const listed = (await (await call('/user/tokens')).json()) as { tokens: Array<{ tokenId: string; tokenPrefix: string | null; repoGrants: Array<{ fullName: string }> }> };
    const row = listed.tokens.find((t) => t.tokenId === minted.tokenId);
    expect(row?.tokenPrefix).toBe(minted.prefix);
    expect(row?.repoGrants).toMatchObject([{ fullName: 'alice/full' }]);

    // Read grant: fetch OK, push forbidden, other repos hidden.
    expect((await call('/alice/full/info/refs?service=git-upload-pack', { headers: { Authorization: `Bearer ${minted.token}` } })).status).toBe(200);
    expect((await call('/alice/full/info/refs?service=git-receive-pack', { headers: { Authorization: `Bearer ${minted.token}` } })).status).toBe(403);
    expect((await call('/alice/empty/info/refs?service=git-upload-pack', { headers: { Authorization: `Bearer ${minted.token}` } })).status).toBe(401);

    const rotated = await post(`/user/tokens/${minted.tokenId}/rotate`, {});
    expect(rotated.status).toBe(201);
    expect((await call('/alice/full/info/refs?service=git-upload-pack', { headers: { Authorization: `Bearer ${minted.token}` } })).status).toBe(401);
    const fresh = ((await rotated.json()) as { token: string }).token;
    expect((await call('/alice/full/info/refs?service=git-upload-pack', { headers: { Authorization: `Bearer ${fresh}` } })).status).toBe(200);
  });
});
