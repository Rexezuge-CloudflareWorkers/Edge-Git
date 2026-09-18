import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'rename-cascade';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(init?: RequestInit): RequestInit {
  return { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } };
}

describe('username rename on real D1', () => {
  beforeAll(async () => {
    await setupIntegrationTest(env as unknown as TestEnv, USER);
    const created = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name: REPO }) }));
    expect(created.status).toBe(201);
  });

  it('exposes the bootstrapped identity', async () => {
    const me = (await (await api('/user/me')).json()) as { email: string; username: string | null };
    expect(me.email).toBe(USER);
    expect(me.username).toBeTruthy();
  });

  it('rejects reserved and malformed handles', async () => {
    for (const bad of ['user', 'new', '-dash', 'a..b']) {
      const res = await api('/user/me/username', json({ method: 'PATCH', body: JSON.stringify({ username: bad }) }));
      expect(res.status).toBe(400);
    }
  });

  it('renames and cascades owned repos to the new owner', async () => {
    const next = 'renamed-owner';
    const res = await api('/user/me/username', json({ method: 'PATCH', body: JSON.stringify({ username: next }) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; username: string };
    expect(body).toMatchObject({ email: USER, username: next });

    const me = (await (await api('/user/me')).json()) as { username: string };
    expect(me.username).toBe(next);

    // D1 cascade: the repo moved to the new owner namespace.
    expect((await api(`/user/repos/${next}/${REPO}`)).status).toBe(200);
    expect((await api(`/user/repos/${OWNER}/${REPO}`)).status).toBe(404);

    // Profile lookup follows the new handle.
    expect((await api(`/users/${next}`)).status).toBe(200);
  });

  it('is idempotent for the current handle', async () => {
    const res = await api('/user/me/username', json({ method: 'PATCH', body: JSON.stringify({ username: 'renamed-owner' }) }));
    expect(res.status).toBe(200);
  });
});
