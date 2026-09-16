import { describe, expect, it } from 'vitest';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import type { D1Queryable } from '@edge-git/backend-data/utils';

interface Row extends Record<string, unknown> {}

function createProfileFakeDb() {
  const state = {
    users: [] as Row[],
    namespaces: [] as Row[],
    orgs: [] as Row[],
    members: [] as Row[],
    repos: [] as Row[],
    tokens: [] as Row[],
    issues: [] as Row[],
    comments: [] as Row[],
  };

  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM users WHERE email = ?') || q.includes('FROM users WHERE lower(email)')) {
          return Promise.resolve(
            (state.users.find((u) => String(u.email).toLowerCase() === String(params[0]).toLowerCase()) ?? null) as T | null,
          );
        }
        if (q.includes('FROM users WHERE lower(username) = ?')) {
          return Promise.resolve(
            (state.users.find((u) => String(u.username ?? '').toLowerCase() === String(params[0]).toLowerCase()) ?? null) as T | null,
          );
        }
        if (q.includes('FROM organizations WHERE username_ci = ?')) {
          return Promise.resolve((state.orgs.find((o) => o.username_ci === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM organizations WHERE id = ?')) {
          return Promise.resolve((state.orgs.find((o) => o.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM organization_members WHERE org_id = ? AND') && q.includes('user_email')) {
          return Promise.resolve(
            (state.members.find((m) => m.org_id === params[0] && String(m.user_email).toLowerCase() === String(params[1]).toLowerCase()) ?? null) as T | null,
          );
        }
        if (q.includes('FROM namespaces WHERE username_ci = ?')) {
          return Promise.resolve((state.namespaces.find((n) => n.username_ci === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE lower(owner) = ? AND lower(name) = ?')) {
          return Promise.resolve(
            (
              state.repos.find(
                (r) => String(r.owner).toLowerCase() === String(params[0]).toLowerCase() && String(r.name).toLowerCase() === String(params[1]).toLowerCase(),
              ) ?? null
            ) as T | null,
          );
        }
        if (q.includes('FROM repositories WHERE owner = ? AND name = ?')) {
          return Promise.resolve((state.repos.find((r) => r.owner === params[0] && r.name === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE id = ?')) {
          return Promise.resolve((state.repos.find((r) => r.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('SELECT COUNT(*) AS n FROM organization_members')) {
          const n = state.members.filter((m) => m.org_id === params[0] && m.role === 'owner').length;
          return Promise.resolve({ n } as unknown as T);
        }
        if (q.includes('COALESCE(MAX(number)')) {
          const max = state.issues.filter((i) => i.repository_id === params[0]).reduce((m, i) => Math.max(m, i.number as number), 0);
          return Promise.resolve({ max_n: max } as unknown as T);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM repositories WHERE lower(owner) = ? ORDER BY')) {
          const rows = state.repos
            .filter((r) => String(r.owner).toLowerCase() === String(params[0]).toLowerCase())
            .sort((a, b) => (b.updated_at as number) - (a.updated_at as number))
            .slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM repositories WHERE owner = ? ORDER BY')) {
          const rows = state.repos
            .filter((r) => r.owner === params[0])
            .sort((a, b) => (b.updated_at as number) - (a.updated_at as number))
            .slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM repositories WHERE owner_email = ?') || q.includes('FROM repositories WHERE lower(owner_email)')) {
          return Promise.resolve({
            results: state.repos.filter((r) => String(r.owner_email).toLowerCase() === String(params[0]).toLowerCase()) as T[],
          });
        }
        if (q.includes('FROM repositories WHERE org_id = ?')) {
          const rows = state.repos
            .filter((r) => r.org_id === params[0])
            .sort((a, b) => (b.updated_at as number) - (a.updated_at as number))
            .slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM organization_members WHERE org_id = ? ORDER BY')) {
          const rows = state.members
            .filter((m) => m.org_id === params[0])
            .sort((a, b) => (a.created_at as number) - (b.created_at as number))
            .slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM organization_members WHERE') && q.includes('user_email') && q.includes('ORDER BY')) {
          const rows = state.members
            .filter((m) => String(m.user_email).toLowerCase() === String(params[0]).toLowerCase())
            .sort((a, b) => (a.created_at as number) - (b.created_at as number))
            .slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM issues WHERE repository_id = ?')) {
          return Promise.resolve({ results: [] as T[] });
        }
        if (q.includes('FROM comments WHERE issue_id = ?')) {
          return Promise.resolve({ results: [] as T[] });
        }
        if (q.includes('FROM user_access_tokens WHERE') && q.includes('user_email')) {
          return Promise.resolve({ results: [] as T[] });
        }
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO users (email, created_at)')) {
          const [email, created_at] = params as [string, number];
          if (!state.users.some((u) => u.email === email)) state.users.push({ email, created_at, username: null, display_name: null, updated_at: null });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE users SET username = COALESCE(username, ?)')) {
          const [username, now, email] = params as [string, number, string];
          const row = state.users.find((u) => u.email === email);
          if (row && !row.username) {
            row.username = username;
            row.updated_at = now;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT OR IGNORE INTO namespaces') || q.startsWith('INSERT INTO namespaces')) {
          const [username_ci, kind, user_email, org_id, created_at] = params as [string, string, string | null, string | null, number];
          if (!state.namespaces.some((n) => n.username_ci === username_ci)) {
            state.namespaces.push({ username_ci, kind, user_email, org_id, created_at });
          } else if (q.startsWith('INSERT INTO namespaces') && !q.includes('OR IGNORE')) {
            throw new Error('UNIQUE constraint failed: namespaces.username_ci');
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM namespaces WHERE username_ci = ?')) {
          state.namespaces = state.namespaces.filter((n) => n.username_ci !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO organizations (id, username, username_ci')) {
          const [id, username, username_ci, display_name, creator_email, created_at, updated_at] = params as Array<string | number | null>;
          state.orgs.push({ id, username, username_ci, display_name, creator_email, created_at, updated_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM organization_members WHERE org_id = ?')) {
          if (params.length >= 3) {
            state.members = state.members.filter(
              (m) => !(m.org_id === params[0] && String(m.user_email).toLowerCase() === String(params[1]).toLowerCase() && m.user_email !== params[2]),
            );
          } else {
            state.members = state.members.filter(
              (m) => !(m.org_id === params[0] && String(m.user_email).toLowerCase() === String(params[1]).toLowerCase()),
            );
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO organization_members (org_id, user_email, role')) {
          const [org_id, user_email, role, created_at] = params as [string, string, string, number];
          const normalized = String(user_email).toLowerCase();
          state.members = state.members.filter(
            (m) => !(m.org_id === org_id && String(m.user_email).toLowerCase() === normalized && m.user_email !== normalized),
          );
          const existing = state.members.find((m) => m.org_id === org_id && m.user_email === normalized);
          if (existing) existing.role = role;
          else state.members.push({ org_id, user_email: normalized, role, created_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO repositories')) {
          if (params.length >= 13) {
            const [id, owner_email, owner, name, description, is_private, created_at, updated_at, owner_type, owner_ci, name_ci, owner_user_email, org_id] =
              params as Array<string | number | null>;
            state.repos.push({ id, owner_email, owner, name, description, is_private, created_at, updated_at, owner_type, owner_ci, name_ci, owner_user_email, org_id });
          } else {
            const [id, owner_email, owner, name, description, is_private, created_at, updated_at] = params as Array<string | number | null>;
            state.repos.push({ id, owner_email, owner, name, description, is_private, created_at, updated_at, owner_type: 'user', owner_ci: String(owner).toLowerCase(), name_ci: String(name).toLowerCase(), owner_user_email: owner_email, org_id: null });
          }
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

function createEnv(db: D1Queryable, devEmail?: string) {
  const stub = createStub();
  return {
    DB: db,
    REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    CRON_TASKS: { get: () => stub, idFromName: (n: string) => n },
    ...(devEmail ? { DEV_AUTH_EMAIL: devEmail } : {}),
  };
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };

describe('profile + permission management surface', () => {
  it('serves user profiles, repos, and orgs with viewer filtering', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const db = createProfileFakeDb();
    const aliceEnv = createEnv(db, 'alice@example.com');
    const anonEnv = createEnv(db);
    const call = (path: string, init?: RequestInit): Promise<Response> =>
      worker.onRequest(new Request(`https://git.example.com${path}`, init), aliceEnv, ctx);
    const callAnon = (path: string, init?: RequestInit): Promise<Response> =>
      worker.onRequest(new Request(`https://git.example.com${path}`, init), anonEnv, ctx);

    // Bootstrap alice via authed identity, then create a public repo.
    expect((await call('/user/me').then((r) => r.json())).email).toBe('alice@example.com');
    const json = { 'Content-Type': 'application/json' };
    expect((await call('/user/repos', { method: 'POST', headers: json, body: JSON.stringify({ name: 'pub' }) })).status).toBe(201);
    expect((await call('/user/repos', { method: 'POST', headers: json, body: JSON.stringify({ name: 'sec', isPrivate: true }) })).status).toBe(201);

    const profile = (await (await callAnon('/users/alice')).json()) as { type: string; repoCount: number; viewerIsSelf: boolean };
    expect(profile).toMatchObject({ type: 'user', viewerIsSelf: false });
    expect(profile.repoCount).toBe(1);

    const ownProfile = (await (await call('/users/alice')).json()) as { repoCount: number; viewerIsSelf: boolean };
    expect(ownProfile).toMatchObject({ viewerIsSelf: true });
    expect(ownProfile.repoCount).toBe(2);

    const anonRepos = (await (await callAnon('/users/alice/repos')).json()) as { repos: Array<{ name: string }> };
    expect(anonRepos.repos.map((r) => r.name)).toEqual(['pub']);
    const ownRepos = (await (await call('/users/alice/repos?limit=1')).json()) as { repos: Array<{ name: string }> };
    expect(ownRepos.repos).toHaveLength(1);

    expect(((await callAnon('/users/alice/orgs')).json())).resolves.toMatchObject({ username: 'alice', orgs: [] });
    expect((await callAnon('/users/missing')).status).toBe(404);
    expect((await callAnon('/users/missing/repos')).status).toBe(404);
    expect((await callAnon('/users/missing/orgs')).status).toBe(404);
  });

  it('serves org profiles with restricted member counts and manages shell routes', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const db = createProfileFakeDb();
    const aliceEnv = createEnv(db, 'alice@example.com');
    const anonEnv = createEnv(db);
    const call = (path: string, init?: RequestInit): Promise<Response> =>
      worker.onRequest(new Request(`https://git.example.com${path}`, init), aliceEnv, ctx);
    const callAnon = (path: string, init?: RequestInit): Promise<Response> =>
      worker.onRequest(new Request(`https://git.example.com${path}`, init), anonEnv, ctx);
    const json = { 'Content-Type': 'application/json' };

    await call('/user/me');
    const created = await call('/user/orgs', { method: 'POST', headers: json, body: JSON.stringify({ username: 'acme' }) });
    expect(created.status).toBe(201);
    expect((await call('/user/repos', { method: 'POST', headers: json, body: JSON.stringify({ owner: 'acme', name: 'site' }) })).status).toBe(201);

    const anonOrg = (await (await callAnon('/users/acme')).json()) as { type: string; memberCount: unknown; viewerIsMember: boolean };
    expect(anonOrg).toMatchObject({ type: 'org', memberCount: null, viewerIsMember: false });
    const ownOrg = (await (await call('/users/acme')).json()) as { memberCount: number; viewerIsOwner: boolean; repoCount: number };
    expect(ownOrg).toMatchObject({ memberCount: 1, viewerIsOwner: true, repoCount: 1 });

    // Explicit authed role for the SPA Manage-tab fallback when the public
    // profile endpoint is anonymous at the edge.
    const authedOrg = (await (await call('/user/orgs/acme')).json()) as { username: string; viewerRole: string; members: unknown[] };
    expect(authedOrg).toMatchObject({ username: 'acme', viewerRole: 'owner' });
    expect(authedOrg.members).toHaveLength(1);
    expect((await callAnon('/user/orgs/acme')).status).toBe(401);

    const orgRepos = (await (await callAnon('/users/acme/repos')).json()) as { repos: Array<{ name: string }> };
    expect(orgRepos.repos.map((r) => r.name)).toContain('site');

    // SPA shell: single-segment profile serves HTML, reserved roots stay 404.
    const shell = await callAnon('/alice');
    expect(shell.status).toBe(200);
    expect(shell.headers.get('content-type')).toContain('text/html');
    expect((await callAnon('/repos')).status).toBe(404);
    expect((await callAnon('/users')).status).toBe(404);
  });

  it('resolves org ownership case-insensitively for mixed-case emails', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const db = createProfileFakeDb();
    const upperEnv = createEnv(db, 'Alice@Example.COM');
    const lowerEnv = createEnv(db, 'alice@example.com');
    const callUpper = (path: string, init?: RequestInit): Promise<Response> =>
      worker.onRequest(new Request(`https://git.example.com${path}`, init), upperEnv, ctx);
    const callLower = (path: string, init?: RequestInit): Promise<Response> =>
      worker.onRequest(new Request(`https://git.example.com${path}`, init), lowerEnv, ctx);
    const json = { 'Content-Type': 'application/json' };

    await callUpper('/user/me');
    expect((await callUpper('/user/orgs', { method: 'POST', headers: json, body: JSON.stringify({ username: 'acme' }) })).status).toBe(201);

    // Same mailbox in different case still sees ownership on public + authed surfaces.
    const publicOrg = (await (await callLower('/users/acme')).json()) as { viewerIsOwner: boolean; viewerIsMember: boolean };
    expect(publicOrg).toMatchObject({ viewerIsOwner: true, viewerIsMember: true });
    const authedOrg = (await (await callLower('/user/orgs/acme')).json()) as { viewerRole: string };
    expect(authedOrg).toMatchObject({ viewerRole: 'owner' });
  });
});
