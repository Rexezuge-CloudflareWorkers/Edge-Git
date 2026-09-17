import { afterEach, describe, expect, it, vi } from 'vitest';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { WebhookDAO } from '@edge-git/backend-data/dao/WebhookDAO';
import { WebhookDeliveryDAO } from '@edge-git/backend-data/dao/WebhookDeliveryDAO';
import {
  WEBHOOK_EVENTS,
  buildWebhookPayload,
  generateHookSecret,
  mapRepoEventToWebhookEvent,
  maskUrl,
  normalizeEvents,
  secretSuffix,
  signDelivery,
  validateWebhookUrl,
  verifyDeliverySignature,
} from '@edge-git/backend-services/webhook/WebhookEvents';
import { WebhookService } from '@edge-git/backend-services/webhook/WebhookService';
import { WebhookDeliveryService } from '@edge-git/backend-services/webhook/WebhookDeliveryService';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { CRON_TASK_DEFINITIONS, WebhookDeliveryTask } from '@edge-git/background/scheduled';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';

afterEach(() => {
  vi.unstubAllGlobals();
});

// In-memory D1 fake covering users/namespaces (auth bootstrap),
// repositories (requireRole), organizations/collaborators (no-access), and
// the two webhook tables.
function createWebhookFakeDb() {
  const state = {
    users: [] as Array<Record<string, unknown>>,
    namespaces: [] as Array<Record<string, unknown>>,
    repos: [] as Array<Record<string, unknown>>,
    hooks: [] as Array<Record<string, unknown>>,
    deliveries: [] as Array<Record<string, unknown>>,
  };

  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM users WHERE lower(email)')) {
          const row = state.users.find((u) => String(u.email).toLowerCase() === String(params[0]).toLowerCase());
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM users WHERE lower(username)')) {
          const row = state.users.find((u) => String(u.username ?? '').toLowerCase() === String(params[0]).toLowerCase());
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM namespaces WHERE username_ci')) {
          const row = state.namespaces.find((n) => n.username_ci === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM organizations')) return Promise.resolve(null);
        if (q.includes('FROM repo_collaborators')) return Promise.resolve(null);
        if (q.includes('FROM repositories WHERE lower(owner)')) {
          const row = state.repos.find((r) => String(r.owner).toLowerCase() === String(params[0]).toLowerCase() && String(r.name).toLowerCase() === String(params[1]).toLowerCase());
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE owner = ? AND name = ?')) {
          const row = state.repos.find((r) => r.owner === params[0] && r.name === params[1]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM repo_webhooks WHERE id = ? AND repository_id = ?')) {
          const row = state.hooks.find((h) => h.id === params[0] && h.repository_id === params[1]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM repo_webhooks WHERE id = ?')) {
          const row = state.hooks.find((h) => h.id === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.startsWith('SELECT COUNT(*) AS n FROM repo_webhooks')) {
          return Promise.resolve({ n: state.hooks.filter((h) => h.repository_id === params[0]).length } as unknown as T);
        }
        if (q.includes('FROM webhook_deliveries WHERE id = ?')) {
          const row = state.deliveries.find((d) => d.id === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.startsWith('SELECT COUNT(*) AS n FROM webhook_deliveries')) {
          return Promise.resolve({ n: state.deliveries.filter((d) => d.hook_id === params[0]).length } as unknown as T);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM repo_webhooks WHERE repository_id = ?')) {
          const rows = state.hooks
            .filter((h) => h.repository_id === params[0])
            .sort((a, b) => (a.created_at as number) - (b.created_at as number) || String(a.id).localeCompare(String(b.id)));
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes("FROM webhook_deliveries WHERE status = 'pending'")) {
          const rows = state.deliveries
            .filter((d) => d.status === 'pending' && (d.next_retry_at as number) <= (params[0] as number))
            .sort((a, b) => (a.next_retry_at as number) - (b.next_retry_at as number) || String(a.id).localeCompare(String(b.id)))
            .slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM webhook_deliveries WHERE hook_id = ?')) {
          let rows = state.deliveries
            .filter((d) => d.hook_id === params[0])
            .sort((a, b) => (b.created_at as number) - (a.created_at as number) || String(b.id).localeCompare(String(a.id)));
          if (params.length === 5) {
            const [, cutoff, , lastId, limitPlus] = params as [unknown, number, number, string, number];
            rows = rows.filter((d) => (d.created_at as number) < cutoff || ((d.created_at as number) === cutoff && String(d.id) < lastId));
            return Promise.resolve({ results: rows.slice(0, limitPlus) as T[] });
          }
          return Promise.resolve({ results: rows.slice(0, params[1] as number) as T[] });
        }
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO users')) {
          const [email, created_at] = params as [string, number];
          if (!state.users.some((u) => u.email === email)) state.users.push({ email, created_at, username: null, updated_at: null });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE users SET')) {
          const row = state.users.find((u) => u.email === params[2]);
          if (row) {
            if (q.includes('COALESCE(username')) {
              row.username = (row.username as string | null) ?? (params[0] as string);
              row.updated_at = (row.updated_at as number | null) ?? (params[1] as number);
            } else {
              row.username = params[0] as string;
              row.updated_at = params[1] as number;
            }
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes('INTO namespaces')) {
          const [username_ci, kind, user_email, org_id, created_at] = params as [string, string, string, null, number];
          if (!state.namespaces.some((n) => n.username_ci === username_ci)) {
            state.namespaces.push({ username_ci, kind, user_email, org_id, created_at });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO repo_webhooks')) {
          const [id, repository_id, full_name, url, url_prefix, secret, secret_suffix, events, creator_email, created_at, updated_at] = params as Array<
            string | number
          >;
          state.hooks.push({
            id,
            repository_id,
            full_name,
            url,
            url_prefix,
            secret,
            secret_suffix,
            events,
            is_active: 1,
            consecutive_failures: 0,
            last_delivery_at: null,
            last_delivery_status: null,
            creator_email,
            created_at,
            updated_at,
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE repo_webhooks SET last_delivery_at')) {
          const hook = state.hooks.find((h) => h.id === params.at(-1));
          if (hook) {
            const now = params[0] as number;
            hook.last_delivery_at = now;
            hook.updated_at = now;
            if (q.includes('consecutive_failures + 1')) {
              hook.last_delivery_status = 'failure';
              hook.consecutive_failures = (hook.consecutive_failures as number) + 1;
              if ((hook.consecutive_failures as number) >= (params[2] as number)) hook.is_active = 0;
            } else {
              hook.last_delivery_status = 'success';
              hook.consecutive_failures = 0;
            }
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE repo_webhooks SET secret = ?')) {
          const [secret, suffix, now, id] = params as [string, string, number, string];
          const hook = state.hooks.find((h) => h.id === id);
          if (hook) {
            hook.secret = secret;
            hook.secret_suffix = suffix;
            hook.consecutive_failures = 0;
            hook.updated_at = now;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE repo_webhooks SET')) {
          const setClause = q.slice('UPDATE repo_webhooks SET'.length, q.indexOf(' WHERE '));
          const cols = setClause.split(',').map((s) => s.trim().split(' ')[0]);
          const [id, repositoryId] = params.slice(-2) as [string, string];
          const hook = state.hooks.find((h) => h.id === id && h.repository_id === repositoryId);
          if (hook) {
            cols.forEach((col, i) => {
              hook[col] = params[i];
            });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repo_webhooks WHERE id = ?')) {
          const before = state.hooks.length;
          state.hooks = state.hooks.filter((h) => !(h.id === params[0] && h.repository_id === params[1]));
          return Promise.resolve({ success: true, meta: { changes: before - state.hooks.length } });
        }
        if (q.startsWith('DELETE FROM repo_webhooks WHERE repository_id = ?')) {
          state.hooks = state.hooks.filter((h) => h.repository_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO webhook_deliveries')) {
          const [id, hook_id, repository_id, event, event_id, payload, next_retry_at, created_at, updated_at] = params as Array<string | number | null>;
          state.deliveries.push({
            id,
            hook_id,
            repository_id,
            event,
            event_id,
            payload,
            status: 'pending',
            attempts: 0,
            next_retry_at,
            last_http_status: null,
            last_error: null,
            created_at,
            updated_at,
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes('SET attempts = attempts + 1')) {
          const row = state.deliveries.find((d) => d.id === params[1]);
          if (row && row.status === 'pending') {
            row.attempts = (row.attempts as number) + 1;
            row.updated_at = params[0] as number;
            return Promise.resolve({ success: true, meta: { changes: 1 } });
          }
          return Promise.resolve({ success: true, meta: { changes: 0 } });
        }
        if (q.startsWith('UPDATE webhook_deliveries SET status = ?')) {
          const [status, next_retry_at, http, err, now, id] = params as [string, number, number | null, string | null, number, string];
          const row = state.deliveries.find((d) => d.id === id);
          if (row) {
            row.status = status;
            row.next_retry_at = next_retry_at;
            row.last_http_status = http;
            row.last_error = err;
            row.updated_at = now;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes("SET status = 'pending'")) {
          const row = state.deliveries.find((d) => d.id === params[2]);
          if (row) {
            row.status = 'pending';
            row.attempts = 0;
            row.next_retry_at = params[0] as number;
            row.last_http_status = null;
            row.last_error = null;
            row.updated_at = params[1] as number;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM webhook_deliveries WHERE repository_id = ?')) {
          state.deliveries = state.deliveries.filter((d) => d.repository_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes('DELETE FROM webhook_deliveries')) {
          const [cutoff, limit] = params as [number, number];
          const victims = state.deliveries
            .filter((d) => (d.created_at as number) < cutoff)
            .slice(0, limit)
            .map((d) => d.id);
          state.deliveries = state.deliveries.filter((d) => !victims.includes(d.id));
          return Promise.resolve({ success: true, meta: { changes: victims.length } });
        }
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      },
    };
  }

  const db = {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return statement(query, params);
        },
      };
    },
  };
  return { db: db as unknown as D1Queryable, state };
}

function seedRepo(state: ReturnType<typeof createWebhookFakeDb>['state'], overrides: Record<string, unknown> = {}) {
  state.repos.push({
    id: 'repo-1',
    owner_email: 'alice@example.com',
    owner: 'alice',
    name: 'demo',
    description: null,
    is_private: 0,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    owner_type: 'user',
    owner_ci: 'alice',
    name_ci: 'demo',
    owner_user_email: 'alice@example.com',
    org_id: null,
    ...overrides,
  });
}

function routeEnv(db: D1Queryable) {
  return { DB: db, DEV_AUTH_EMAIL: 'alice@example.com' };
}

const routeCtx = { waitUntil: () => undefined, passThroughOnException: () => undefined };

async function callRoute(db: D1Queryable, path: string, init?: RequestInit): Promise<Response> {
  const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
  return worker.onRequest(new Request(`https://git.example.com${path}`, init), routeEnv(db), routeCtx);
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

describe('webhook event helpers', () => {
  it('lists the supported webhook events', () => {
    expect([...WEBHOOK_EVENTS]).toEqual(['push', 'repository', 'issues', 'issue_comment', 'pull_request', 'pull_request_review', 'fork', 'star', 'watch', 'release', 'project', 'discussion', 'discussion_comment', 'wiki', 'snippet', 'check_run', 'check_suite', 'ping']);
  });

  it('normalizes event subscriptions', () => {
    expect(normalizeEvents(['push', 'push', 'star'])).toEqual(['push', 'star']);
    expect(() => normalizeEvents([])).toThrow();
    expect(() => normalizeEvents(['nope'])).toThrow();
    expect(() => normalizeEvents('push')).toThrow();
  });

  it('maps every repo event type to a webhook event', () => {
    expect(mapRepoEventToWebhookEvent('push')).toBe('push');
    expect(mapRepoEventToWebhookEvent('repo_created')).toBe('repository');
    expect(mapRepoEventToWebhookEvent('issue_opened')).toBe('issues');
    expect(mapRepoEventToWebhookEvent('issue_closed')).toBe('issues');
    expect(mapRepoEventToWebhookEvent('issue_reopened')).toBe('issues');
    expect(mapRepoEventToWebhookEvent('issue_commented')).toBe('issue_comment');
    expect(mapRepoEventToWebhookEvent('pr_opened')).toBe('pull_request');
    expect(mapRepoEventToWebhookEvent('pr_closed')).toBe('pull_request');
    expect(mapRepoEventToWebhookEvent('pr_merged')).toBe('pull_request');
    expect(mapRepoEventToWebhookEvent('pr_reviewed')).toBe('pull_request_review');
    expect(mapRepoEventToWebhookEvent('pr_commented')).toBe('pull_request_review');
    expect(mapRepoEventToWebhookEvent('fork_created')).toBe('fork');
    expect(mapRepoEventToWebhookEvent('release_created')).toBe('release');
    expect(mapRepoEventToWebhookEvent('release_published')).toBe('release');
    expect(mapRepoEventToWebhookEvent('project_created')).toBe('project');
    expect(mapRepoEventToWebhookEvent('project_closed')).toBe('project');
    expect(mapRepoEventToWebhookEvent('project_reopened')).toBe('project');
    expect(mapRepoEventToWebhookEvent('discussion_opened')).toBe('discussion');
    expect(mapRepoEventToWebhookEvent('discussion_answered')).toBe('discussion');
    expect(mapRepoEventToWebhookEvent('discussion_locked')).toBe('discussion');
    expect(mapRepoEventToWebhookEvent('discussion_commented')).toBe('discussion_comment');
    expect(mapRepoEventToWebhookEvent('wiki_created')).toBe('wiki');
    expect(mapRepoEventToWebhookEvent('wiki_updated')).toBe('wiki');
    expect(mapRepoEventToWebhookEvent('snippet_created')).toBe('snippet');
  });

  it('validates hook URLs with a best-effort SSRF guard', () => {
    expect(() => validateWebhookUrl('https://hooks.example.com/edge-git')).not.toThrow();
    expect(() => validateWebhookUrl('http://hooks.example.com/hook')).not.toThrow();
    expect(() => validateWebhookUrl('')).toThrow();
    expect(() => validateWebhookUrl('ftp://hooks.example.com/x')).toThrow();
    expect(() => validateWebhookUrl('/relative/path')).toThrow();
    expect(() => validateWebhookUrl('https://user:pass@hooks.example.com/')).toThrow();
    expect(() => validateWebhookUrl('http://localhost/hook')).toThrow();
    expect(() => validateWebhookUrl('http://127.0.0.1/hook')).toThrow();
    expect(() => validateWebhookUrl('http://10.1.2.3/hook')).toThrow();
    expect(() => validateWebhookUrl('http://192.168.1.1/hook')).toThrow();
    expect(() => validateWebhookUrl('http://172.20.0.1/hook')).toThrow();
    expect(() => validateWebhookUrl('http://169.254.169.254/latest')).toThrow();
    expect(() => validateWebhookUrl(`https://hooks.example.com/${'a'.repeat(2048)}`)).toThrow();
  });

  it('masks URLs and suffixes secrets', () => {
    expect(maskUrl('https://hooks.example.com/edge-git-hook')).toBe('https://hooks.example.com/edge...');
    expect(maskUrl('short')).toBe('short');
    expect(secretSuffix('abcdefgh')).toBe('efgh');
  });

  it('generates unique per-hook secrets', () => {
    const first = generateHookSecret();
    const second = generateHookSecret();
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(first).not.toBe(second);
  });

  it('signs and verifies delivery payloads', async () => {
    const signature = await signDelivery('hook-secret', '{"event":"push"}');
    expect(signature.startsWith('sha256=')).toBe(true);
    await expect(verifyDeliverySignature('hook-secret', '{"event":"push"}', signature)).resolves.toBe(true);
    await expect(verifyDeliverySignature('hook-secret', '{"event":"ping"}', signature)).resolves.toBe(false);
    await expect(verifyDeliverySignature('other-secret', '{"event":"push"}', signature)).resolves.toBe(false);
  });

  it('builds bounded payloads', () => {
    const payload = buildWebhookPayload({
      event: 'issues',
      fullName: 'alice/demo',
      actorEmail: 'alice@example.com',
      subjectNumber: 3,
      title: 'A'.repeat(500),
      processedAt: 1_700_000_000,
    });
    expect(payload).toMatchObject({ event: 'issues', subject_number: 3, processed_at: 1_700_000_000 });
    expect((payload.title as string).length).toBe(200);
  });

  it('exposes backoff and retryability rules', () => {
    expect(WebhookDeliveryService.backoffSecondsForAttempt(1)).toBe(60);
    expect(WebhookDeliveryService.backoffSecondsForAttempt(2)).toBe(600);
    expect(WebhookDeliveryService.backoffSecondsForAttempt(3)).toBe(3600);
    expect(WebhookDeliveryService.backoffSecondsForAttempt(4)).toBe(21_600);
    expect(WebhookDeliveryService.backoffSecondsForAttempt(5)).toBe(86_400);
    expect(WebhookDeliveryService.backoffSecondsForAttempt(99)).toBe(86_400);
    expect(WebhookDeliveryService.isRetryableHttpStatus(null)).toBe(true);
    expect(WebhookDeliveryService.isRetryableHttpStatus(429)).toBe(true);
    expect(WebhookDeliveryService.isRetryableHttpStatus(500)).toBe(true);
    expect(WebhookDeliveryService.isRetryableHttpStatus(200)).toBe(false);
    expect(WebhookDeliveryService.isRetryableHttpStatus(400)).toBe(false);
    expect(WebhookDeliveryService.isRetryableHttpStatus(404)).toBe(false);
  });
});

describe('webhook DAOs', () => {
  it('round-trips hooks through the DAO', async () => {
    const { db } = createWebhookFakeDb();
    const dao = new WebhookDAO(db);
    await dao.create({
      id: 'h1',
      repositoryId: 'repo-1',
      fullName: 'alice/demo',
      url: 'https://hooks.example.com/a',
      urlPrefix: 'https://hooks.example.com/a',
      secret: 's3cret-value',
      secretSuffix: 'alue',
      eventsJson: JSON.stringify(['push']),
      creatorEmail: 'alice@example.com',
      now: 100,
    });
    expect(await dao.countByRepo('repo-1')).toBe(1);
    expect((await dao.listByRepo('repo-1')).map((h) => h.id)).toEqual(['h1']);
    expect((await dao.getByIdAndRepo('h1', 'repo-1'))?.url).toBe('https://hooks.example.com/a');
    expect(await dao.getByIdAndRepo('h1', 'other')).toBeNull();
    await dao.update('h1', 'repo-1', { url: 'https://hooks.example.com/b', urlPrefix: 'https://hooks.example.com/b', now: 101 });
    expect((await dao.getById('h1'))?.url).toBe('https://hooks.example.com/b');
    await dao.rotateSecret('h1', 'repo-1', 'brand-new-secret', 'cret', 102);
    expect((await dao.getById('h1'))?.secret).toBe('brand-new-secret');
    await dao.recordDeliveryOutcome('h1', true, 103, 20);
    expect((await dao.getById('h1'))?.consecutive_failures).toBe(0);
    await dao.recordDeliveryOutcome('h1', false, 104, 2);
    expect((await dao.getById('h1'))?.consecutive_failures).toBe(1);
    await dao.recordDeliveryOutcome('h1', false, 105, 2);
    const disabled = await dao.getById('h1');
    expect(disabled?.consecutive_failures).toBe(2);
    expect(disabled?.is_active).toBe(0);
    await dao.deleteById('h1', 'repo-1');
    expect(await dao.countByRepo('repo-1')).toBe(0);
  });

  it('round-trips deliveries with claims and cursor pagination', async () => {
    const { db } = createWebhookFakeDb();
    const dao = new WebhookDeliveryDAO(db);
    await dao.enqueue({ id: 'd1', hookId: 'h1', repositoryId: 'repo-1', event: 'push', payload: '{}', nextRetryAt: 100, now: 100 });
    await dao.enqueue({ id: 'd2', hookId: 'h1', repositoryId: 'repo-1', event: 'push', payload: '{}', nextRetryAt: 200, now: 100 });
    expect((await dao.listDue(150, 10)).map((d) => d.id)).toEqual(['d1']);
    expect(await dao.claim('d1', 150)).toBe(true);
    expect(await dao.claim('d1', 150)).toBe(true);
    await dao.markSettled('d1', { status: 'success', nextRetryAt: 150, httpStatus: 200, error: null, now: 150 });
    const first = await dao.listByHook('h1', 1);
    expect(first.deliveries.map((d) => d.id)).toEqual(['d2']);
    expect(first.nextCursor).not.toBeNull();
    const second = await dao.listByHook('h1', 1, first.nextCursor ?? undefined);
    expect(second.deliveries.map((d) => d.id)).toEqual(['d1']);
    expect(await dao.countByHook('h1')).toBe(2);
    await dao.resetForRedelivery('d1', 300);
    expect((await dao.getById('d1'))?.status).toBe('pending');
    expect(await dao.pruneOlderThan(400, 100)).toBe(2);
  });
});

describe('WebhookService', () => {
  function stubDao(overrides: Record<string, unknown> = {}) {
    return {
      create: vi.fn().mockResolvedValue(undefined),
      listByRepo: vi.fn().mockResolvedValue([]),
      getByIdAndRepo: vi.fn().mockResolvedValue(null),
      countByRepo: vi.fn().mockResolvedValue(0),
      update: vi.fn().mockResolvedValue(undefined),
      rotateSecret: vi.fn().mockResolvedValue(undefined),
      deleteById: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  function service(dao: ReturnType<typeof stubDao>, env: Record<string, unknown> = {}) {
    return new WebhookService({ DB: {} } as never, { webhookDAO: async () => dao as never });
  }

  it('creates hooks with a one-time secret and masked lists', async () => {
    const dao = stubDao();
    const svc = service(dao);
    const { hook, secret } = await svc.createHook({ repositoryId: 'repo-1', fullName: 'alice/demo', url: 'https://hooks.example.com/x', creatorEmail: 'alice@example.com' });
    expect(secret.length).toBeGreaterThanOrEqual(16);
    expect(hook.urlMasked).toBe('https://hooks.example.com/x'.slice(0, 30) + (('https://hooks.example.com/x'.length > 30) ? '...' : ''));
    expect(hook.hasSecret).toBe(true);
    expect(hook.events).toEqual(['push']);
    expect(dao.create).toHaveBeenCalledOnce();
  });

  it('accepts custom secrets and event subsets', async () => {
    const dao = stubDao();
    const svc = service(dao);
    const { hook, secret } = await svc.createHook({
      repositoryId: 'repo-1',
      fullName: 'alice/demo',
      url: 'https://hooks.example.com/x',
      events: ['issues', 'star'],
      secret: 'my-custom-secret-value',
      creatorEmail: 'alice@example.com',
    });
    expect(secret).toBe('my-custom-secret-value');
    expect(hook.secretSuffix).toBe('alue');
    expect(hook.events).toEqual(['issues', 'star']);
  });

  it('rejects invalid input and enforces the per-repo cap', async () => {
    const svc = service(stubDao());
    await expect(svc.createHook({ repositoryId: 'r', fullName: 'a/b', url: 'http://127.0.0.1/x', creatorEmail: 'a@x.com' })).rejects.toThrow();
    await expect(svc.createHook({ repositoryId: 'r', fullName: 'a/b', url: 'https://ok.example.com/', events: ['nope'], creatorEmail: 'a@x.com' })).rejects.toThrow();
    await expect(svc.createHook({ repositoryId: 'r', fullName: 'a/b', url: 'https://ok.example.com/', events: [], creatorEmail: 'a@x.com' })).rejects.toThrow();
    await expect(
      svc.createHook({ repositoryId: 'r', fullName: 'a/b', url: 'https://ok.example.com/', secret: 'short', creatorEmail: 'a@x.com' }),
    ).rejects.toThrow();
    const capped = service(stubDao({ countByRepo: vi.fn().mockResolvedValue(10) }));
    await expect(capped.createHook({ repositoryId: 'r', fullName: 'a/b', url: 'https://ok.example.com/', creatorEmail: 'a@x.com' })).rejects.toThrow(/Maximum 10/);
  });

  it('reads, updates, rotates, and deletes with 404s', async () => {
    const row = {
      id: 'h1',
      repository_id: 'repo-1',
      full_name: 'alice/demo',
      url: 'https://hooks.example.com/x',
      url_prefix: 'https://hooks.example.com/x',
      secret: 's3cret',
      secret_suffix: 'cret',
      events: JSON.stringify(['push']),
      is_active: 1,
      consecutive_failures: 0,
      last_delivery_at: null,
      last_delivery_status: null,
      creator_email: 'alice@example.com',
      created_at: 1,
      updated_at: 1,
    };
    const dao = stubDao({
      getByIdAndRepo: vi.fn(async (id: string) => (id === 'h1' ? { ...row } : null)),
      update: vi.fn(async (_id: string, _repo: string, patch: { url?: string; eventsJson?: string; isActive?: boolean }) => {
        if (patch.url !== undefined) row.url = patch.url;
        if (patch.eventsJson !== undefined) row.events = patch.eventsJson;
        if (patch.isActive !== undefined) row.is_active = patch.isActive ? 1 : 0;
      }),
    });
    const svc = service(dao);
    expect((await svc.getHook('h1', 'repo-1')).id).toBe('h1');
    await expect(svc.getHook('missing', 'repo-1')).rejects.toThrow();
    const updated = await svc.updateHook('h1', 'repo-1', { isActive: false });
    expect(updated.isActive).toBe(false);
    await expect(svc.updateHook('h1', 'repo-1', { url: 'http://10.0.0.1/' })).rejects.toThrow();
    await expect(svc.updateHook('h1', 'repo-1', { events: ['bogus'] })).rejects.toThrow();
    const rotated = await svc.rotateHookSecret('h1', 'repo-1');
    expect(rotated.secret).not.toBe('s3cret');
    expect(dao.rotateSecret).toHaveBeenCalledOnce();
    await svc.deleteHook('h1', 'repo-1');
    expect(dao.deleteById).toHaveBeenCalledWith('h1', 'repo-1');
    const missing = service(stubDao());
    await expect(missing.deleteHook('h1', 'repo-1')).rejects.toThrow();
  });
});

describe('WebhookDeliveryService', () => {
  const hookRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'h1',
    repository_id: 'repo-1',
    full_name: 'alice/demo',
    url: 'https://hooks.example.com/x',
    url_prefix: 'https://hooks.example.com/x',
    secret: 'hook-secret',
    secret_suffix: 'cret',
    events: JSON.stringify(['push', 'issues']),
    is_active: 1,
    consecutive_failures: 0,
    last_delivery_at: null,
    last_delivery_status: null,
    creator_email: 'alice@example.com',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  });

  function deliveryService(deps: { hooks?: unknown[]; postJson?: (url: string, init: { headers: Record<string, string>; body: string; timeoutMs: number }) => Promise<{ httpStatus: number | null; error: string | null }> }) {
    const deliveries: Array<Record<string, unknown>> = [];
    const webhookDAO = { listByRepo: vi.fn().mockResolvedValue(deps.hooks ?? []), getById: vi.fn(async (id: string) => (deps.hooks as Array<{ id: string }> | undefined)?.find((h) => h.id === id) ?? null), getByIdAndRepo: vi.fn() };
    const deliveryDAO = {
      enqueue: vi.fn(async (input: Record<string, unknown>) => {
        deliveries.push({ ...input, status: 'pending', attempts: 0, last_http_status: null, last_error: null, created_at: input.now, updated_at: input.now });
      }),
      listDue: vi.fn().mockResolvedValue([]),
      claim: vi.fn().mockResolvedValue(true),
      markSettled: vi.fn().mockResolvedValue(undefined),
      resetForRedelivery: vi.fn().mockResolvedValue(undefined),
      listByHook: vi.fn().mockResolvedValue({ deliveries: [], nextCursor: null }),
      getById: vi.fn().mockResolvedValue(null),
      pruneOlderThan: vi.fn().mockResolvedValue(7),
    };
    const svc = new WebhookDeliveryService({ DB: {} } as never, {
      webhookDAO: async () => webhookDAO as never,
      deliveryDAO: async () => deliveryDAO as never,
      ...(deps.postJson ? { postJson: deps.postJson } : {}),
    });
    return { svc, webhookDAO, deliveryDAO, deliveries };
  }

  it('enqueues only for active, subscribed hooks and never throws', async () => {
    const { svc, deliveryDAO } = deliveryService({
      hooks: [hookRow(), hookRow({ id: 'h2', is_active: 0 }), hookRow({ id: 'h3', events: JSON.stringify(['star']) })],
    });
    const { enqueued } = await svc.enqueueForEvent({ repositoryId: 'repo-1', fullName: 'alice/demo', event: 'push', actorEmail: 'alice@example.com' });
    expect(enqueued).toBe(1);
    expect(deliveryDAO.enqueue).toHaveBeenCalledOnce();
    const broken = new WebhookDeliveryService({ DB: {} } as never, {
      webhookDAO: async () => {
        throw new Error('legacy DB without webhooks table');
      },
    });
    await expect(broken.enqueueForEvent({ repositoryId: 'r', fullName: 'a/b', event: 'push', actorEmail: 'a@x.com' })).resolves.toEqual({ enqueued: 0 });
  });

  it('marks HTTP success and resets hook failures', async () => {
    const seen: Array<{ headers: Record<string, string>; body: string }> = [];
    const { svc, deliveryDAO, webhookDAO } = deliveryService({
      hooks: [hookRow()],
      postJson: async (_url, init) => {
        seen.push({ headers: init.headers, body: init.body });
        return { httpStatus: 200, error: null };
      },
    });
    (deliveryDAO.listDue as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'd1', hook_id: 'h1', event: 'push', payload: '{"event":"push"}', attempts: 0 }]);
    (deliveryDAO.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'd1', hook_id: 'h1', event: 'push', payload: '{"event":"push"}', attempts: 0 });
    webhookDAO.getById = vi.fn().mockResolvedValue(hookRow());
    const recordOutcome = vi.fn().mockResolvedValue(undefined);
    (webhookDAO as unknown as Record<string, unknown>).recordDeliveryOutcome = recordOutcome;
    const summary = await svc.processDue({ now: 1000 });
    expect(summary).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0].headers['X-EdgeGit-Event']).toBe('push');
    expect(seen[0].headers['X-EdgeGit-Delivery']).toBe('d1');
    expect(seen[0].headers['X-EdgeGit-Signature-256'].startsWith('sha256=')).toBe(true);
    expect(recordOutcome).toHaveBeenCalledWith('h1', true, 1000, 20);
  });

  it('retries retryable failures then fails terminally with auto-disable accounting', async () => {
    const calls: unknown[] = [];
    const { svc, deliveryDAO, webhookDAO } = deliveryService({
      hooks: [hookRow()],
      postJson: async () => {
        calls.push(1);
        return { httpStatus: 500, error: 'Webhook returned HTTP 500' };
      },
    });
    (deliveryDAO.listDue as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'd1', hook_id: 'h1', payload: '{}', attempts: 0 }]);
    (deliveryDAO.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'd1', hook_id: 'h1', payload: '{}', attempts: 0 });
    webhookDAO.getById = vi.fn().mockResolvedValue(hookRow());
    const recordOutcome = vi.fn().mockResolvedValue(undefined);
    (webhookDAO as unknown as Record<string, unknown>).recordDeliveryOutcome = recordOutcome;
    const summary = await svc.processDue({ now: 1000 });
    expect(summary).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    expect(deliveryDAO.markSettled).toHaveBeenCalledWith('d1', expect.objectContaining({ status: 'pending', nextRetryAt: 1060 }));
    expect(recordOutcome).not.toHaveBeenCalled();

    (deliveryDAO.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'd1', hook_id: 'h1', payload: '{}', attempts: 4 });
    await svc.processDue({ now: 2000 });
    expect(deliveryDAO.markSettled).toHaveBeenLastCalledWith('d1', expect.objectContaining({ status: 'failed' }));
    expect(recordOutcome).toHaveBeenCalledWith('h1', false, 2000, 20);
  });

  it('fails fast on terminal 4xx and on missing/disabled hooks', async () => {
    const { svc, deliveryDAO, webhookDAO } = deliveryService({
      hooks: [hookRow()],
      postJson: async () => ({ httpStatus: 400, error: 'Webhook returned HTTP 400' }),
    });
    (deliveryDAO.listDue as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'd1', hook_id: 'h1', payload: '{}', attempts: 0 }]);
    (deliveryDAO.getById as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'd1', hook_id: 'h1', payload: '{}', attempts: 0 });
    const recordOutcome = vi.fn().mockResolvedValue(undefined);
    (webhookDAO as unknown as Record<string, unknown>).recordDeliveryOutcome = recordOutcome;
    webhookDAO.getById = vi.fn().mockResolvedValue(hookRow({ is_active: 0 }));
    expect(await svc.processDue({ now: 1000 })).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    expect(deliveryDAO.markSettled).toHaveBeenCalledWith('d1', expect.objectContaining({ status: 'failed' }));

    webhookDAO.getById = vi.fn().mockResolvedValue(hookRow());
    expect(await svc.processDue({ now: 1000 })).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    expect(deliveryDAO.markSettled).toHaveBeenLastCalledWith('d1', expect.objectContaining({ status: 'failed', nextRetryAt: 1000 }));
  });

  it('skips rows lost in a claim race', async () => {
    const { svc, deliveryDAO } = deliveryService({ hooks: [hookRow()] });
    (deliveryDAO.listDue as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'd1' }]);
    (deliveryDAO.claim as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    expect(await svc.processDue({ now: 1000 })).toEqual({ processed: 0, succeeded: 0, failed: 0 });
  });

  it('redelivers, pings, lists, and prunes', async () => {
    const { svc, deliveryDAO, webhookDAO } = deliveryService({ hooks: [hookRow()] });
    (deliveryDAO.getById as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) =>
      id === 'd9' ? { id: 'd9', hook_id: 'h1', repository_id: 'repo-1' } : null,
    );
    webhookDAO.getByIdAndRepo = vi.fn(async (id: string) => (id === 'h1' ? hookRow() : null));
    await svc.redeliver('d9', 'repo-1');
    expect(deliveryDAO.resetForRedelivery).toHaveBeenCalledWith('d9', expect.any(Number));
    await expect(svc.redeliver('missing', 'repo-1')).rejects.toThrow();
    (deliveryDAO.listByHook as ReturnType<typeof vi.fn>).mockResolvedValue({ deliveries: [], nextCursor: null });
    await expect(svc.listDeliveries('h1', 'repo-1', 20)).resolves.toEqual({ deliveries: [], nextCursor: null });
    webhookDAO.getByIdAndRepo = vi.fn().mockResolvedValue(null);
    await expect(svc.listDeliveries('h1', 'repo-1', 20)).rejects.toThrow();
    expect(await svc.pruneOlderThan(1, 500)).toBe(7);
  });
});

describe('webhook composition and cron', () => {
  it('resolves webhook services from the request scope', () => {
    const scope = createRequestScope({ DB: {} } as never);
    expect(scope.has(Tokens.WebhookDAO)).toBe(true);
    expect(scope.has(Tokens.WebhookDeliveryDAO)).toBe(true);
    expect(scope.has(Tokens.WebhookService)).toBe(true);
    expect(scope.has(Tokens.WebhookDeliveryService)).toBe(true);
    expect(scope.get(Tokens.WebhookService)).toBe(scope.get(Tokens.WebhookService));
    expect(scope.get(Tokens.WebhookDeliveryService)).toBe(scope.get(Tokens.WebhookDeliveryService));
  });

  it('registers the delivery task in phase 2', () => {
    const task = CRON_TASK_DEFINITIONS.find((t) => t.name === 'WebhookDeliveryTask');
    expect(task).toBeDefined();
    expect(task?.phase).toBe(2);
    expect(task).toBeInstanceOf(WebhookDeliveryTask);
  });

  it('flushes due deliveries end to end with signed POSTs', async () => {
    const { db, state } = createWebhookFakeDb();
    seedRepo(state);
    const hookDao = new WebhookDAO(db);
    await hookDao.create({
      id: 'h1',
      repositoryId: 'repo-1',
      fullName: 'alice/demo',
      url: 'https://hooks.example.com/x',
      urlPrefix: 'https://hooks.example.com/x',
      secret: 'cron-secret',
      secretSuffix: 'cret',
      eventsJson: JSON.stringify(['push']),
      creatorEmail: 'alice@example.com',
      now: 100,
    });
    const deliveryDao = new WebhookDeliveryDAO(db);
    await deliveryDao.enqueue({ id: 'd1', hookId: 'h1', repositoryId: 'repo-1', event: 'push', payload: '{"event":"push"}', nextRetryAt: 100, now: 100 });
    const posts: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        posts.push({ url, init });
        return new Response('ok', { status: 200 });
      }),
    );
    await new WebhookDeliveryTask().run({ DB: db } as unknown as Env);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://hooks.example.com/x');
    const headers = posts[0].init.headers as Record<string, string>;
    expect(headers['X-EdgeGit-Event']).toBe('push');
    expect(headers['X-EdgeGit-Delivery']).toBe('d1');
    expect(headers['X-EdgeGit-Signature-256'].startsWith('sha256=')).toBe(true);
    expect((await deliveryDao.getById('d1'))?.status).toBe('success');
    expect((await hookDao.getById('h1'))?.consecutive_failures).toBe(0);
  });
});

describe('webhook HTTP routes', () => {
  it('covers the full hook lifecycle over HTTP', async () => {
    const { db, state } = createWebhookFakeDb();
    seedRepo(state);

    const created = await callRoute(db, '/user/repos/alice/demo/hooks', json('POST', { url: 'https://hooks.example.com/edge', events: ['push', 'issues'] }));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { hook: { id: string; urlMasked: string; hasSecret: boolean }; secret: string };
    expect(createdBody.secret.length).toBeGreaterThanOrEqual(16);
    expect(createdBody.hook.hasSecret).toBe(true);
    const hookId = createdBody.hook.id;

    const listed = (await (await callRoute(db, '/user/repos/alice/demo/hooks')).json()) as { hooks: Array<{ id: string; secret?: string }>; events: string[] };
    expect(listed.hooks).toHaveLength(1);
    expect(listed.hooks[0].secret).toBeUndefined();
    expect(listed.events).toContain('ping');

    expect((await callRoute(db, '/user/repos/alice/demo/hooks', json('POST', { url: 'http://127.0.0.1/x' }))).status).toBe(400);
    expect((await callRoute(db, '/user/repos/alice/demo/hooks', json('POST', { url: 'https://hooks.example.com/y', events: ['bogus'] }))).status).toBe(400);
    expect((await callRoute(db, '/user/repos/alice/demo/hooks', json('POST', {}))).status).toBe(400);

    const fetched = await callRoute(db, `/user/repos/alice/demo/hooks/${hookId}`);
    expect(fetched.status).toBe(200);
    expect((await callRoute(db, '/user/repos/alice/demo/hooks/missing')).status).toBe(404);

    const patched = await callRoute(db, `/user/repos/alice/demo/hooks/${hookId}`, json('PATCH', { events: ['star'], isActive: false }));
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { hook: { events: string[]; isActive: boolean } }).hook).toMatchObject({ events: ['star'], isActive: false });

    const rotated = await callRoute(db, `/user/repos/alice/demo/hooks/${hookId}/rotate-secret`, { method: 'POST' });
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as { secret: string };
    expect(rotatedBody.secret).not.toBe(createdBody.secret);

    const reactivated = await callRoute(db, `/user/repos/alice/demo/hooks/${hookId}`, json('PATCH', { isActive: true }));
    expect(reactivated.status).toBe(200);

    const posts: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        posts.push({ url, init });
        return new Response('ok', { status: 200 });
      }),
    );
    const tested = await callRoute(db, `/user/repos/alice/demo/hooks/${hookId}/test`, { method: 'POST' });
    expect(tested.status).toBe(201);
    const testedBody = (await tested.json()) as { delivery: { id: string; event: string; status: string } };
    expect(testedBody.delivery.event).toBe('ping');
    expect(testedBody.delivery.status).toBe('success');
    expect(posts).toHaveLength(1);

    const deliveries = (await (await callRoute(db, `/user/repos/alice/demo/hooks/${hookId}/deliveries`)).json()) as {
      deliveries: Array<{ id: string }>;
    };
    expect(deliveries.deliveries.map((d) => d.id)).toContain(testedBody.delivery.id);

    const redelivered = await callRoute(db, `/user/repos/alice/demo/hooks/${hookId}/deliveries/${testedBody.delivery.id}/redeliver`, { method: 'POST' });
    expect(redelivered.status).toBe(200);

    const removed = await callRoute(db, `/user/repos/alice/demo/hooks/${hookId}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect((await callRoute(db, `/user/repos/alice/demo/hooks/${hookId}`)).status).toBe(404);
  });

  it('hides webhooks on missing repos and gates strangers', async () => {
    const { db, state } = createWebhookFakeDb();
    seedRepo(state);
    expect((await callRoute(db, '/user/repos/alice/missing/hooks')).status).toBe(404);
    // Public repo: strangers keep read access (masked list) but cannot mutate.
    const strangerEnv = { DB: db, DEV_AUTH_EMAIL: 'mallory@example.com' };
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const listed = await worker.onRequest(new Request('https://git.example.com/user/repos/alice/demo/hooks'), strangerEnv, routeCtx);
    expect(listed.status).toBe(200);
    const denied = await worker.onRequest(
      new Request('https://git.example.com/user/repos/alice/demo/hooks', json('POST', { url: 'https://hooks.example.com/evil' })),
      strangerEnv,
      routeCtx,
    );
    expect(denied.status).toBe(403);
  });

  it('enqueues webhook deliveries when issues are created', async () => {
    const { db, state } = createWebhookFakeDb();
    seedRepo(state);
    const created = await callRoute(db, '/user/repos/alice/demo/hooks', json('POST', { url: 'https://hooks.example.com/edge', events: ['issues'] }));
    expect(created.status).toBe(201);
    const issue = await callRoute(db, '/user/repos/alice/demo/issues', json('POST', { title: 'Webhook E2E' }));
    expect(issue.status).toBe(201);
    expect(state.deliveries.filter((d) => d.event === 'issues')).toHaveLength(1);
  });
});
