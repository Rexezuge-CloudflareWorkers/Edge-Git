import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'realtime-demo';

type TestEnv = Record<string, unknown> & { DB: D1Database; REALTIME: DurableObjectNamespace };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(init?: RequestInit): RequestInit {
  return { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } };
}

async function body<T>(res: Response): Promise<T> {
  expect(res.status).toBeLessThan(400);
  return (await res.json()) as T;
}

describe('realtime lifecycle on real D1 + DO', () => {
  beforeAll(async () => {
    await setupIntegrationTest(env as unknown as TestEnv, USER);
    const res = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name: REPO, description: 'Realtime Repo' }) }));
    expect([200, 201, 409]).toContain(res.status);
  });

  it('issues repo tickets for read+ viewers with their channels', async () => {
    const ticket = await body<{ shard: string; ticket: string; expiresAt: number; channels: string[] }>(
      await api('/user/realtime/ticket', json({ method: 'POST', body: JSON.stringify({ owner: OWNER, repo: REPO, channels: ['issue:1', 'activity', 'presence', 'bogus'] }) })),
    );
    expect(ticket.shard).toBe(`repo:${OWNER}/${REPO}`);
    expect(typeof ticket.ticket).toBe('string');
    expect(ticket.expiresAt).toBeGreaterThan(0);
    expect(ticket.channels.sort()).toEqual(['activity', 'issue:1', 'presence']);
  });

  it('rejects tickets for unknown repos and empty channels', async () => {
    expect((await api('/user/realtime/ticket', json({ method: 'POST', body: JSON.stringify({ owner: OWNER, repo: 'nope', channels: ['activity'] }) }))).status).toBe(
      404,
    );
    expect((await api('/user/realtime/ticket', json({ method: 'POST', body: JSON.stringify({ owner: OWNER, repo: REPO, channels: ['bogus'] }) }))).status).toBe(
      403,
    );
    expect((await api('/user/realtime/ticket', json({ method: 'POST', body: JSON.stringify({ owner: OWNER }) }))).status).toBe(400);
  });

  it('issues self-scoped inbox tickets', async () => {
    const ticket = await body<{ shard: string; ticket: string; channels: string[] }>(await api('/user/realtime/inbox-ticket'));
    expect(ticket.shard).toBe('inbox:global');
    expect(ticket.channels).toHaveLength(1);
    expect(ticket.channels[0]).toMatch(/^inbox:[0-9a-f]{16}$/);
  });

  it('gates the upgrade endpoint by shard and protocol', async () => {
    expect((await api('/realtime/ws?shard=bogus')).status).toBe(404);
    expect((await api(`/realtime/ws?shard=repo:${OWNER}/${REPO}`)).status).toBe(426);
  });

  it('publishes via DO RPC without sockets and reports stats', async () => {
    const testEnv = env as unknown as TestEnv;
    const stub = testEnv.REALTIME.getByName(`repo:${OWNER}/${REPO}`);
    const issued = (await (stub as unknown as { issueTicket(input: unknown): Promise<unknown> }).issueTicket({
      shard: `repo:${OWNER}/${REPO}`,
      channels: ['activity'],
      viewer: USER,
    })) as { ticket?: string; error?: string };
    expect(typeof issued.ticket).toBe('string');
    const published = (await (stub as unknown as { publish(input: unknown): Promise<unknown> }).publish({
      channel: 'activity',
      type: 'repo.push',
      actor: USER,
      title: 'Push',
    })) as { delivered: number };
    expect(published).toEqual({ delivered: 0 });
    const stats = (await (stub as unknown as { getStats(): Promise<unknown> }).getStats()) as { connections: number };
    expect(stats.connections).toBe(0);
  });

  it('keeps mutations working with live publish active', async () => {
    const created = await body<{ number: number }>(
      await api(`/user/repos/${OWNER}/${REPO}/issues`, json({ method: 'POST', body: JSON.stringify({ title: 'Live Issue', body: 'hello' }) })),
    );
    expect(created.number).toBeGreaterThan(0);
    const commented = await api(
      `/user/repos/${OWNER}/${REPO}/issues/${created.number}/comments`,
      json({ method: 'POST', body: JSON.stringify({ body: 'live comment' }) }),
    );
    expect(commented.status).toBeLessThan(400);
    const activity = await body<{ events: Array<{ type: string }> }>(await api(`/repos/${OWNER}/${REPO}/activity`));
    expect(activity.events.map((e) => e.type)).toContain('issue_commented');
  });
});
