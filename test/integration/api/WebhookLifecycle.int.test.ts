import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'webhook-demo';

type TestEnv = Record<string, unknown> & { DB: D1Database };

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

describe('webhook lifecycle on real D1', () => {
  beforeAll(async () => {
    await setupIntegrationTest(env as unknown as TestEnv, USER);
    const res = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name: REPO, description: 'Webhook Repo' }) }));
    expect(res.status).toBe(201);
  });

  it('creates hooks with a one-time secret and masked lists', async () => {
    const created = await body<{ hook: { id: string; urlMasked: string; hasSecret: boolean; events: string[] }; secret: string }>(
      await api(
        `/user/repos/${OWNER}/${REPO}/hooks`,
        json({
          method: 'POST',
          body: JSON.stringify({ url: 'https://hooks.example.com/edge-git-deliveries', events: ['issues', 'push'] }),
        }),
      ),
    );
    expect(created.secret.length).toBeGreaterThanOrEqual(16);
    expect(created.hook.hasSecret).toBe(true);
    expect(created.hook.urlMasked).toContain('...');
    expect(created.hook.events).toEqual(['issues', 'push']);

    const listed = await body<{ hooks: Array<{ id: string; secret?: string; hasSecret: boolean }>; events: string[] }>(
      await api(`/user/repos/${OWNER}/${REPO}/hooks`),
    );
    expect(listed.hooks).toHaveLength(1);
    expect(listed.hooks[0].secret).toBeUndefined();
    expect(listed.hooks[0].hasSecret).toBe(true);
    expect(listed.events).toContain('ping');
    expect(listed.events).toContain('star');
  });

  it('rejects invalid hook input', async () => {
    expect((await api(`/user/repos/${OWNER}/${REPO}/hooks`, json({ method: 'POST', body: JSON.stringify({}) }))).status).toBe(400);
    expect(
      (await api(`/user/repos/${OWNER}/${REPO}/hooks`, json({ method: 'POST', body: JSON.stringify({ url: 'http://127.0.0.1/x' }) })))
        .status,
    ).toBe(400);
    expect(
      (
        await api(
          `/user/repos/${OWNER}/${REPO}/hooks`,
          json({ method: 'POST', body: JSON.stringify({ url: 'https://hooks.example.com/y', events: ['bogus'] }) }),
        )
      ).status,
    ).toBe(400);
    expect((await api(`/user/repos/${OWNER}/missing/hooks`)).status).toBe(404);
  });

  it('enqueues deliveries when issues are created', async () => {
    const created = await body<{ number: number }>(
      await api(`/user/repos/${OWNER}/${REPO}/issues`, json({ method: 'POST', body: JSON.stringify({ title: 'Webhook E2E' }) })),
    );
    expect(created.number).toBeGreaterThan(0);
    const db = (env as unknown as TestEnv).DB;
    const rows = (await db.prepare("SELECT * FROM webhook_deliveries WHERE event = 'issues'").all()).results as Array<{
      event: string;
      status: string;
      payload: string;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(['pending', 'success', 'failed']).toContain(rows[0].status);
    expect(rows[0].payload).toContain('webhook');
  });

  it('pings, lists, redelivers, rotates, and deletes', async () => {
    const listed = await body<{ hooks: Array<{ id: string }> }>(await api(`/user/repos/${OWNER}/${REPO}/hooks`));
    const hookId = listed.hooks[0].id;

    const tested = await body<{ delivery: { id: string; event: string } }>(
      await api(`/user/repos/${OWNER}/${REPO}/hooks/${hookId}/test`, { method: 'POST' }),
    );
    expect(tested.delivery.event).toBe('ping');

    const deliveries = await body<{ deliveries: Array<{ id: string; event: string }> }>(
      await api(`/user/repos/${OWNER}/${REPO}/hooks/${hookId}/deliveries`),
    );
    expect(deliveries.deliveries.map((d) => d.id)).toContain(tested.delivery.id);

    const redelivered = await body<{ delivery: { id: string } }>(
      await api(`/user/repos/${OWNER}/${REPO}/hooks/${hookId}/deliveries/${tested.delivery.id}/redeliver`, { method: 'POST' }),
    );
    expect(redelivered.delivery.id).toBe(tested.delivery.id);

    const before = await body<{ hook: { secretSuffix: string } }>(await api(`/user/repos/${OWNER}/${REPO}/hooks/${hookId}`));
    const rotated = await body<{ hook: { secretSuffix: string }; secret: string }>(
      await api(`/user/repos/${OWNER}/${REPO}/hooks/${hookId}/rotate-secret`, { method: 'POST' }),
    );
    expect(rotated.secret.length).toBeGreaterThanOrEqual(16);

    const repatched = await body<{ hook: { events: string[]; isActive: boolean } }>(
      await api(
        `/user/repos/${OWNER}/${REPO}/hooks/${hookId}`,
        json({ method: 'PATCH', body: JSON.stringify({ events: ['star'], isActive: false }) }),
      ),
    );
    expect(repatched.hook).toMatchObject({ events: ['star'], isActive: false });
    expect(before.hook.secretSuffix).not.toBe(rotated.hook.secretSuffix);

    expect((await api(`/user/repos/${OWNER}/${REPO}/hooks/${hookId}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(`/user/repos/${OWNER}/${REPO}/hooks/${hookId}`)).status).toBe(404);
  });
});
