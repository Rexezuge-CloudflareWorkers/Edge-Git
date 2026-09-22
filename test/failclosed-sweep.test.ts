import { beforeEach, describe, expect, it } from 'vitest';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import { resetRateLimitForTests } from '@/middleware/rateLimit';

// Fail-closed sweep (Slice 5): every major route against a totally down D1.
// Goals: (1) prove no handler hangs or throws uncaught under outage — every
// request resolves to an HTTP status; (2) prove mutations fail closed (never
// 2xx when persistence is gone); (3) execute the `.catch` fallback closures
// that happy-path fakes never reach (UserRoutes funcs 23% → up).
// DB whose statements fail the way a real D1 outage does: `prepare`/`bind`
// succeed, but execution rejects asynchronously (so `withRetry` wraps them
// into `DatabaseError`, driving the 503 fail-closed paths — a *synchronous*
// `prepare` throw would bypass classification, which real D1 never does for
// connection failures).
function outageDb(): D1Queryable {
  const boom = (): Promise<never> => Promise.reject(new Error('D1 outage'));
  return {
    prepare: () => ({ bind: (..._params: unknown[]) => ({ first: boom, all: boom, run: boom }) }),
  } as unknown as D1Queryable;
}

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function callWorker(env: unknown, path: string, init?: RequestInit): Promise<Response> {
  const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
  return worker.onRequest(new Request(`https://git.example.com${path}`, init), env, CTX);
}

function authedEnv(): Record<string, unknown> {
  return { DB: outageDb(), ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'alice@example.com' };
}

function postJson(body: unknown): RequestInit {
  return { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) };
}

describe('fail-closed sweep under D1 outage', () => {
  beforeEach(() => {
    resetRateLimitForTests();
  });

  it('public reads always resolve (shell, JSON, or typed error)', async () => {
    const env = authedEnv();
    const paths = [
      '/users/alice',
      '/users/alice/repos?limit=abc',
      '/users/alice/repos?limit=500',
      '/users/alice/orgs',
      '/repos/alice/demo',
      '/repos/alice/demo/branches',
      '/repos/alice/demo/tree?ref=main',
      '/repos/alice/demo/blob?ref=main&path=f.txt',
      '/repos/alice/demo/commits?ref=main',
      '/repos/alice/demo/issues',
      '/repos/alice/demo/issues/1',
      '/repos/alice/demo/issues/1/comments',
      '/repos/alice/demo/pulls',
      '/repos/alice/demo/pulls/1',
      '/repos/alice/demo/pulls/1/diff',
      '/repos/alice/demo/pulls/1/preview',
      '/repos/alice/demo/releases',
      '/repos/alice/demo/releases/v1',
      '/repos/alice/demo/releases/v1/assets',
      '/repos/alice/demo/projects',
      '/repos/alice/demo/projects/1',
      '/repos/alice/demo/discussions',
      '/repos/alice/demo/wiki',
      '/repos/alice/demo/wiki/home',
      '/repos/alice/demo/tags',
      '/repos/alice/demo/forks',
      '/repos/alice/demo/labels',
      '/repos/alice/demo/milestones',
      '/repos/alice/demo/overview',
      '/repos/alice/demo/activity',
      '/repos/alice/demo/stars',
      '/repos/alice/demo/watches',
      '/repos/alice/demo/compare?base=main&head=feat',
      '/search?q=demo',
      '/snippets/public',
    ];
    for (const path of paths) {
      const res = await callWorker(env, path);
      expect(res.status, path).toBeGreaterThanOrEqual(200);
      expect(res.status, path).toBeLessThanOrEqual(599);
      await res.arrayBuffer().catch(() => undefined);
    }
  });

  it('authed reads always resolve', async () => {
    const env = authedEnv();
    const paths = [
      '/user/me',
      '/user/repos',
      '/user/tokens',
      '/user/orgs',
      '/user/audit',
      '/user/notifications',
      '/user/stars',
      '/user/watches',
      '/user/snippets',
      '/user/repos/alice/demo',
      '/user/repos/alice/demo/issues',
      '/user/repos/alice/demo/issues/1',
      '/user/repos/alice/demo/issues/1/comments',
      '/user/repos/alice/demo/pulls',
      '/user/repos/alice/demo/pulls/1',
      '/user/repos/alice/demo/pulls/1/comments',
      '/user/repos/alice/demo/pulls/1/reviews',
      '/user/repos/alice/demo/pulls/1/threads',
      '/user/repos/alice/demo/pulls/1/diff',
      '/user/repos/alice/demo/pulls/1/preview',
      '/user/repos/alice/demo/projects',
      '/user/repos/alice/demo/projects/1',
      '/user/repos/alice/demo/discussions',
      '/user/repos/alice/demo/discussions/1',
      '/user/repos/alice/demo/wiki',
      '/user/repos/alice/demo/wiki/home',
      '/user/repos/alice/demo/wiki/home/revisions',
      '/user/repos/alice/demo/releases',
      '/user/repos/alice/demo/releases/v1',
      '/user/repos/alice/demo/releases/v1/assets',
      '/user/repos/alice/demo/branches',
      '/user/repos/alice/demo/tree?ref=main',
      '/user/repos/alice/demo/blob?ref=main&path=f.txt',
      '/user/repos/alice/demo/commits?ref=main',
      '/user/repos/alice/demo/rules',
      '/user/repos/alice/demo/collaborators',
      '/user/repos/alice/demo/checks',
      '/user/repos/alice/demo/keys',
      '/user/repos/alice/demo/hooks',
      '/user/repos/alice/demo/compare?base=main&head=feat',
      '/user/repos/alice/demo/tags',
      '/user/repos/alice/demo/forks',
      '/user/repos/alice/demo/overview',
      '/user/repos/alice/demo/security',
      '/user/orgs/acme/teams',
      '/user/orgs/acme/audit',
    ];
    for (const path of paths) {
      const res = await callWorker(env, path);
      expect(res.status, path).toBeGreaterThanOrEqual(200);
      expect(res.status, path).toBeLessThanOrEqual(599);
      await res.arrayBuffer().catch(() => undefined);
    }
  });

  it('mutations fail closed (never 2xx without persistence)', async () => {
    const env = authedEnv();
    const calls: Array<[string, RequestInit]> = [
      ['/user/repos', postJson({ name: 'sweep' })],
      ['/user/tokens', postJson({ name: 'sweep' })],
      ['/user/orgs', postJson({ username: 'sweeporg' })],
      ['/user/repos/alice/demo/issues', postJson({ title: 'x' })],
      ['/user/repos/alice/demo/issues/1/comments', postJson({ body: 'x' })],
      ['/user/repos/alice/demo/pulls', postJson({ title: 'x' })],
      ['/user/repos/alice/demo/pulls/1/comments', postJson({ body: 'x' })],
      ['/user/repos/alice/demo/pulls/1/reviews', postJson({ state: 'approved' })],
      ['/user/repos/alice/demo/pulls/1/threads', postJson({ path: 'f.txt', body: 'x' })],
      ['/user/repos/alice/demo/pulls/1/merge', postJson({})],
      ['/user/repos/alice/demo/projects', postJson({ title: 'x' })],
      ['/user/repos/alice/demo/projects/1/columns', postJson({ title: 'x' })],
      ['/user/repos/alice/demo/projects/1/cards', postJson({ columnId: 'c', kind: 'note' })],
      ['/user/repos/alice/demo/discussions', postJson({ title: 'x' })],
      ['/user/repos/alice/demo/wiki', postJson({ slug: 'x', title: 'x' })],
      ['/user/repos/alice/demo/releases', postJson({ tagName: 'v9', isDraft: true })],
      ['/user/repos/alice/demo/branches', postJson({ name: 'x' })],
      ['/user/repos/alice/demo/contents', postJson({ path: 'x', content: 'eA==', branch: 'main' })],
      ['/user/repos/alice/demo/fork', postJson({})],
      ['/user/repos/alice/demo/star', postJson({})],
      ['/user/repos/alice/demo/watch', postJson({})],
      ['/user/repos/alice/demo/collaborators', postJson({ email: 'b@x.com', role: 'read' })],
      ['/user/repos/alice/demo/rules', postJson({ pattern: '*' })],
      ['/user/repos/alice/demo/keys', postJson({ title: 'k', key: 'ssh-rsa AAAA' })],
      ['/user/repos/alice/demo/hooks', postJson({ url: 'https://example.com/h', events: ['push'] })],
      ['/user/repos/alice/demo/import', postJson({ sourceUrl: 'https://github.com/o/r' })],
      ['/user/repos/alice/demo/mirror', postJson({})],
      ['/user/orgs/acme/members', postJson({ email: 'b@x.com', role: 'member' })],
      ['/user/realtime/ticket', postJson({ owner: 'alice', repo: 'demo', channels: ['activity'] })],
      ['/user/me/username', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ username: 'bob' }) }],
      ['/user/repos/alice/demo', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ description: 'x' }) }],
      ['/user/repos/alice/demo/issues/1', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ status: 'closed' }) }],
      ['/user/repos/alice/demo/pulls/1', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ title: 'x' }) }],
      ['/user/repos/alice/demo/projects/1', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ title: 'x' }) }],
      ['/user/repos/alice/demo', { method: 'DELETE' }],
      ['/user/tokens/nope', { method: 'DELETE' }],
      ['/user/repos/alice/demo/projects/1', { method: 'DELETE' }],
      ['/user/repos/alice/demo/wiki/home', { method: 'DELETE' }],
      ['/user/orgs/acme/members/bob%40x.com', { method: 'DELETE' }],
    ];
    for (const [path, init] of calls) {
      const res = await callWorker(env, path, init);
      expect(res.status, `${init.method ?? 'GET'} ${path}`).toBeGreaterThanOrEqual(300);
      await res.arrayBuffer().catch(() => undefined);
    }
  });

  it('validates search queries before touching D1', async () => {
    const env = authedEnv();
    expect((await callWorker(env, '/search')).status).toBe(400);
    expect((await callWorker(env, '/search?q=')).status).toBe(400);
    expect((await callWorker(env, `/search?q=${'x'.repeat(201)}`)).status).toBe(400);
    expect((await callWorker(env, '/search?q=%01%02')).status).toBe(400);
  });

  it('authed sub-resources always resolve', async () => {
    const env = authedEnv();
    const paths = [
      '/user/repos/alice/demo/pulls/1/reviews/x/dismiss',
      '/user/repos/alice/demo/releases/v1/assets/a/download',
      '/user/repos/alice/demo/wiki/home/revisions',
      '/user/repos/alice/demo/discussions/1/comments/c1',
      '/user/repos/alice/demo/hooks/h1',
      '/user/repos/alice/demo/hooks/h1/deliveries',
      '/user/repos/alice/demo/hooks/h1/test',
      '/user/repos/alice/demo/hooks/h1/rotate-secret',
      '/user/repos/alice/demo/checks/c1',
      '/user/repos/alice/demo/keys/k1',
      '/user/repos/alice/demo/collaborators/bob',
      '/user/repos/alice/demo/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '/user/repos/alice/demo/blame?ref=main&path=f.txt',
      '/user/repos/alice/demo/export',
      '/user/repos/alice/demo/import/j1/cancel',
      '/user/repos/alice/demo/mirror/sync',
      '/user/repos/alice/demo/mirror/enable',
      '/user/repos/alice/demo/projects/1/columns/c1',
      '/user/repos/alice/demo/projects/1/cards/c1/move',
      '/user/orgs/acme',
      '/user/orgs/acme/members',
      '/user/orgs/acme/members/bob%40x.com',
      '/user/orgs/acme/teams',
      '/user/orgs/acme/teams/t1/members',
      '/user/orgs/acme/teams/t1/repos',
      '/user/tokens/t1',
      '/user/notifications/n1/read',
      '/user/snippets/s1',
      '/user/repos/alice/demo/rules/r1',
      '/user/repos/alice/demo/pulls/1/threads/t1',
    ];
    for (const path of paths) {
      for (const init of [
        undefined,
        postJson({}),
        { method: 'PUT', headers: JSON_HEADERS, body: '{}' },
        { method: 'PATCH', headers: JSON_HEADERS, body: '{}' },
        { method: 'DELETE' },
      ] as Array<RequestInit | undefined>) {
        const res = await callWorker(env, path, init);
        expect(res.status, `${init?.method ?? 'GET'} ${path}`).toBeGreaterThanOrEqual(200);
        expect(res.status, `${init?.method ?? 'GET'} ${path}`).toBeLessThanOrEqual(599);
        await res.arrayBuffer().catch(() => undefined);
      }
    }
  });

  it('git data-plane fails closed with 503, never 401-confusion', async () => {
    const env = authedEnv();
    const refs = await callWorker(env, '/alice/demo/info/refs?service=git-upload-pack');
    expect(refs.status).toBe(503);
    const push = await callWorker(env, '/alice/demo/git-receive-pack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-git-receive-pack-request' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(push.status).toBe(503);
    const fetch = await callWorker(env, '/alice/demo/git-upload-pack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-git-upload-pack-request' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(fetch.status).toBe(503);
  });

  it('cron fan-out resolves on ok, error, and throw', async () => {
    const worker = new EdgeGitWorker() as unknown as {
      onScheduled(e: unknown, env: unknown, ctx: unknown): Promise<void>;
    };
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };
    const cron = { cron: '*/10 * * * *', scheduledTime: 1 };
    const okEnv = { CRON_TASKS: { idFromName: () => 'g', get: () => ({ fetch: async () => new Response('ok') }) } };
    await expect(worker.onScheduled(cron, okEnv, ctx)).resolves.toBeUndefined();
    const errEnv = { CRON_TASKS: { idFromName: () => 'g', get: () => ({ fetch: async () => new Response('bad', { status: 500 }) }) } };
    await expect(worker.onScheduled(cron, errEnv, ctx)).resolves.toBeUndefined();
    const boomEnv = {
      CRON_TASKS: {
        idFromName: () => 'g',
        get: () => ({
          fetch: async (): Promise<never> => {
            throw new Error('DO down');
          },
        }),
      },
    };
    await expect(worker.onScheduled(cron, boomEnv, ctx)).resolves.toBeUndefined();
  });
});
