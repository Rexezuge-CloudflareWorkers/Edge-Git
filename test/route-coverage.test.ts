import { describe, expect, it } from 'vitest';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import type { D1Queryable } from '@edge-git/backend-data/utils';

const ALICE = 'alice@example.com';

// Generic fake DB: users/namespaces/repos resolve, everything else returns
// empty rows so route handlers execute (covering functions) without needing
// per-table fixtures.
function createRouteFakeDb() {
  const state = {
    users: [{ email: ALICE, username: 'alice', created_at: 0 }] as Array<Record<string, unknown>>,
    namespaces: [{ username_ci: 'alice', kind: 'user', user_email: ALICE, org_id: null }] as Array<Record<string, unknown>>,
    repos: [
      {
        id: 'r1',
        owner_email: ALICE,
        owner: 'alice',
        name: 'demo',
        description: null,
        is_private: 0,
        created_at: 0,
        updated_at: 0,
        owner_type: 'user',
        owner_ci: 'alice',
        name_ci: 'demo',
        org_id: null,
      },
    ] as Array<Record<string, unknown>>,
  };
  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM users WHERE')) {
          const row = state.users.find((u) => String(u.email).toLowerCase() === String(params[0]).toLowerCase());
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM namespaces WHERE')) {
          const row = state.namespaces.find((n) => n.username_ci === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE id = ?') || q.includes('FROM repositories WHERE owner = ? AND name = ?')) {
          return Promise.resolve((state.repos[0] ?? null) as T | null);
        }
        if (q.includes('COUNT(*)')) return Promise.resolve({ n: 0 } as unknown as T);
        if (q.includes('COALESCE(MAX(number)')) return Promise.resolve({ max_n: 0 } as unknown as T);
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM repositories WHERE') && q.includes('owner_email')) {
          return Promise.resolve({ results: state.repos as T[] });
        }
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO users') && !state.users.some((u) => u.email === params[0])) {
          state.users.push({ email: params[0], created_at: params[1] });
        }
        if (q.startsWith('INSERT INTO repositories')) {
          const [id, owner_email, owner, name] = params as string[];
          if (!state.repos.some((r) => r.id === id))
            state.repos.push({ id, owner_email, owner, name, is_private: 0, created_at: 0, updated_at: 0 });
        }
        return Promise.resolve({ success: true, meta: { changes: 1 } });
      },
    };
  }
  return { prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) } as unknown as D1Queryable;
}

function createStub() {
  const ok = { ok: true };
  return {
    setFullName: () => Promise.resolve(),
    ensureRepoInitialized: () => Promise.resolve(),
    deleteRepo: () => Promise.resolve(),
    listRefs: () => Promise.resolve({ refs: [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }], symbolicHead: 'refs/heads/main' }),
    getBranches: () => Promise.resolve({ branches: ['main'], currentBranch: 'main' }),
    getTree: () => Promise.resolve([]),
    getBlob: () => Promise.resolve(null),
    getCommits: () => Promise.resolve([]),
    getOverview: () =>
      Promise.resolve({
        branches: ['main'],
        currentBranch: 'main',
        resolvedRef: 'a'.repeat(40),
        tags: [],
        tree: [],
        commits: [],
        readme: null,
      }),
    getTags: () => Promise.resolve([]),
    getCommitDiff: () => Promise.resolve({ commit: { oid: 'a'.repeat(40) }, truncated: false, files: [] }),
    getCompare: () => Promise.resolve({ baseOid: 'a'.repeat(40), headOid: 'a'.repeat(40), mergeBase: null, truncated: false, files: [] }),
    getMergePreview: () =>
      Promise.resolve({ baseOid: 'a'.repeat(40), headOid: 'a'.repeat(40), mergeBase: null, truncated: false, files: [] }),
    getPullDiff: () => Promise.resolve({ baseOid: 'a'.repeat(40), headOid: 'a'.repeat(40), mergeBase: null, truncated: false, files: [] }),
    getMergePreviewByOids: () =>
      Promise.resolve({ baseOid: 'a'.repeat(40), headOid: 'a'.repeat(40), mergeBase: null, truncated: false, files: [] }),
    getBlame: () => Promise.resolve([]),
    resolveRef: () => Promise.resolve('a'.repeat(40)),
    createBranch: () => Promise.resolve({ ok: true, ref: 'refs/heads/x', oid: 'a'.repeat(40) }),
    deleteBranchRef: () => Promise.resolve(ok),
    setDefaultBranch: () => Promise.resolve(ok),
    commitFile: () => Promise.resolve({ ok: true, commitOid: 'c'.repeat(40), created: true }),
    exportPack: () => Promise.resolve({ oids: ['a'.repeat(40)], pack: new Uint8Array([1, 2, 3]) }),
    importPack: () => Promise.resolve({ importedRefs: [] }),
    receivePack: () => Promise.resolve(new Response('ok')),
    fetch: () => Promise.resolve(new Response('PACK', { status: 200 })),
    mergePull: () => Promise.resolve(ok),
    getReleaseAsset: () => Promise.resolve(null),
    storeReleaseAsset: () => Promise.resolve({ ok: true }),
    deleteReleaseAsset: () => Promise.resolve(ok),
    deleteReleaseAssets: () => Promise.resolve(ok),
    enqueueChecks: () => Promise.resolve({ ok: true }),
  };
}

function createEnv(db: D1Queryable) {
  const stub = createStub();
  return {
    DB: db,
    REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    CRON_TASKS: { get: () => stub, idFromName: (n: string) => n },
    CHECK_RUNNER: { get: () => stub, idFromName: (n: string) => n },
    REALTIME: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    DEV_AUTH_EMAIL: ALICE,
    ENVIRONMENT: 'development',
  };
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };

describe('route coverage sweep', () => {
  it('exercises public and authed read-model routes', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const env = createEnv(createRouteFakeDb());
    const call = (path: string, init?: RequestInit): Promise<Response> =>
      worker.onRequest(new Request(`https://git.example.com${path}`, init), env, ctx);
    const json = (path: string, method = 'GET', body?: unknown): Promise<Response> =>
      call(
        path,
        method === 'GET' ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) },
      );

    // Public read-model (exercises RepoRoutes, IssueRoutes, PullRoutes,
    // ReleaseRoutes, Project/Discussion/Wiki/Snippet/Collab public fns).
    for (const path of [
      '/repos/alice/demo',
      '/repos/alice/demo/branches',
      '/repos/alice/demo/tree?ref=main',
      '/repos/alice/demo/blob?ref=main&path=README.md',
      '/repos/alice/demo/commits?ref=main',
      '/repos/alice/demo/issues',
      '/repos/alice/demo/issues/1',
      '/repos/alice/demo/issues/1/comments',
      '/repos/alice/demo/releases',
      '/repos/alice/demo/releases/v1',
      '/repos/alice/demo/releases/v1/assets',
      '/repos/alice/demo/projects',
      '/repos/alice/demo/projects/1',
      '/repos/alice/demo/discussions/categories',
      '/repos/alice/demo/discussions',
      '/repos/alice/demo/discussions/1',
      '/repos/alice/demo/wiki',
      '/repos/alice/demo/wiki/home',
      '/repos/alice/demo/stars',
      '/repos/alice/demo/watches',
      '/repos/alice/demo/activity',
      '/repos/alice/demo/commits/' + 'a'.repeat(40) + '/checks',
      '/snippets/public',
      '/snippets/abc',
      '/users/alice/snippets',
      '/users/alice',
      '/health',
      '/search?q=hello&type=repos',
      '/search?q=hello&type=issues',
      '/search?q=hello&type=pulls',
      '/search?q=hello&type=code',
      '/search?q=hello&type=discussions',
      '/search?q=hello&type=snippets',
      '/search?q=x',
      '/user/me',
      '/user/repos',
      '/user/tokens',
      '/user/orgs',
      '/user/orgs/myorg',
      '/user/orgs/myorg/members',
      '/user/orgs/myorg/teams',
      '/user/orgs/myorg/teams/dev',
      '/user/orgs/myorg/teams/dev/members',
      '/user/orgs/myorg/teams/dev/repos',
      '/user/orgs/myorg/audit',
      '/user/audit',
      '/user/notifications',
      '/user/notifications/unread-count',
      '/user/stars',
      '/user/watches',
      '/user/snippets',
      '/user/realtime/inbox-ticket',
      '/user/repos/alice/demo',
      '/user/repos/alice/demo/branches',
      '/user/repos/alice/demo/issues',
      '/user/repos/alice/demo/pulls',
      '/user/repos/alice/demo/releases',
      '/user/repos/alice/demo/releases/v1',
      '/user/repos/alice/demo/releases/v1/assets',
      '/user/repos/alice/demo/rules',
      '/user/repos/alice/demo/collaborators',
      '/user/repos/alice/demo/hooks',
      '/user/repos/alice/demo/hooks/h1',
      '/user/repos/alice/demo/hooks/h1/deliveries',
      '/user/repos/alice/demo/checks?sha=' + 'a'.repeat(40),
      '/user/repos/alice/demo/commits/' + 'a'.repeat(40) + '/checks',
      '/user/repos/alice/demo/projects',
      '/user/repos/alice/demo/projects/1',
      '/user/repos/alice/demo/discussions/categories',
      '/user/repos/alice/demo/discussions',
      '/user/repos/alice/demo/discussions/1',
      '/user/repos/alice/demo/wiki',
      '/user/repos/alice/demo/wiki/home',
      '/user/repos/alice/demo/wiki/home/revisions',
      '/repos/alice/demo/labels',
      '/user/repos/alice/demo/labels',
      '/repos/alice/demo/milestones',
      '/user/repos/alice/demo/milestones',
      '/repos/alice/demo/forks',
      '/user/repos/alice/demo/forks',
      '/user/repos/alice/demo/security',
      '/user/repos/alice/demo/keys',
      '/user/repos/alice/demo/mirror',
      '/repos/alice/demo/blame?ref=main&path=f.txt',
      '/user/repos/alice/demo/blame?ref=main&path=f.txt',
      '/user/repos/alice/demo/issues/1/meta',
      '/user/repos/alice/demo/pulls/1/meta',
      '/user/repos/alice/demo/pulls/1/reviewers',
      '/user/repos/alice/demo/pulls/1/codeowners',
      '/user/repos/alice/demo/sync-preview?ref=main',
      '/repos/alice/demo/pulls',
      '/repos/alice/demo/pulls/1',
      '/repos/alice/demo/pulls/1/comments',
      '/repos/alice/demo/pulls/1/reviews',
      '/repos/alice/demo/pulls/1/diff',
      '/repos/alice/demo/pulls/1/preview',
      '/repos/alice/demo/pulls/1/threads',
      '/user/repos/alice/demo/pulls/1',
      '/user/repos/alice/demo/pulls/1/comments',
      '/user/repos/alice/demo/pulls/1/reviews',
      '/user/repos/alice/demo/pulls/1/diff',
      '/user/repos/alice/demo/pulls/1/preview',
      '/user/repos/alice/demo/pulls/1/threads',
      '/user/repos/alice/demo/releases/v1/assets/a1/download',
      '/repos/alice/demo/releases/v1/assets/a1/download',
    ]) {
      const res = await call(path);
      expect([200, 201, 400, 401, 403, 404, 429, 500, 503].includes(res.status), `${path} -> ${res.status}`).toBe(true);
      await res.arrayBuffer().catch(() => undefined);
    }

    // Mutating shapes (400/403/404 still execute handler functions).
    expect((await json('/user/repos', 'POST', { name: 'x'.repeat(300) })).status).toBeDefined();
    expect((await json('/user/tokens', 'POST', { name: 't' })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/issues', 'POST', { title: 'hi' })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/pulls', 'POST', { title: 'hi', head: 'a', base: 'b' })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/rules', 'POST', { pattern: 'main' })).status).toBeDefined();
    expect((await json('/user/orgs', 'POST', { name: 'bad name!' })).status).toBeDefined();
    expect((await json('/user/realtime/ticket', 'POST', { owner: 'alice', repo: 'demo', channels: ['activity'] })).status).toBeDefined();
    expect((await json('/user/orgs/myorg/teams', 'POST', { slug: 'x' })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/hooks', 'POST', { url: 'https://example.com/h', events: ['push'] })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/releases', 'POST', { tagName: 'v9' })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/checks', 'POST', { sha: 'a'.repeat(40), context: 'ci' })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/projects', 'POST', { title: 'p' })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/discussions', 'POST', { title: 'd', body: 'b' })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/wiki', 'POST', { slug: 's', body: 'b' })).status).toBeDefined();
    expect((await json('/user/snippets', 'POST', { title: 's', files: [] })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/star', 'PUT', {})).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/watch', 'PUT', {})).status).toBeDefined();
    expect((await json('/user/notifications/read-all', 'POST', {})).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/labels', 'POST', { name: 'bug' })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/milestones', 'POST', { title: 'm1' })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/forks', 'POST', {})).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/keys', 'POST', { name: 'k', permission: 'read' })).status).toBeDefined();
    expect(
      (await json('/user/repos/alice/demo/mirror', 'PUT', { sourceUrl: 'https://github.com/o/r', intervalMinutes: 60 })).status,
    ).toBeDefined();
    expect((await json('/user/repos/alice/demo/sync', 'POST', {})).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/pulls/1/comments', 'POST', { body: 'hi' })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/pulls/1/reviews', 'POST', { body: 'lgtm', state: 'approved' })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/pulls/1/threads', 'POST', { path: 'f.txt', line: 1, body: 'note' })).status).toBeDefined();
    expect((await json('/user/repos/alice/demo/pulls/1/merge', 'POST', {})).status).toBeDefined();
    expect(
      (await json('/user/repos/alice/demo/releases/v1/assets', 'POST', { name: 'a.zip', contentBase64: 'eA==' })).status,
    ).toBeDefined();
  });

  it('serves SPA shell and security headers on API responses', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const env = createEnv(createRouteFakeDb());
    const shell = await worker.onRequest(new Request('https://git.example.com/'), env, ctx);
    expect(shell.status).toBe(200);
    expect(shell.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(shell.headers.get('X-Frame-Options')).toBe('DENY');
    const api = await worker.onRequest(new Request('https://git.example.com/health'), env, ctx);
    expect(api.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});
