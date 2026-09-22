import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { basicAuthHeader, ensureUser, seedRepo, setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'deploy-priv';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(init?: RequestInit): RequestInit {
  return { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } };
}

describe('deploy key lifecycle on real D1', () => {
  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    await ensureUser(testEnv.DB, USER, OWNER);
    await seedRepo(testEnv.DB, { ownerEmail: USER, owner: OWNER, name: REPO, isPrivate: true });
  });

  it('validates key creation input', async () => {
    expect((await api(`/user/repos/${OWNER}/${REPO}/keys`, json({ method: 'POST', body: JSON.stringify({}) }))).status).toBe(400);
    expect(
      (await api(`/user/repos/${OWNER}/${REPO}/keys`, json({ method: 'POST', body: JSON.stringify({ name: 'k', permission: 'owner' }) })))
        .status,
    ).toBe(400);
  });

  it('creates a read key (secret shown once), lists masked, fetches but cannot push', async () => {
    const created = (await (
      await api(`/user/repos/${OWNER}/${REPO}/keys`, json({ method: 'POST', body: JSON.stringify({ name: 'ci-read' }) }))
    ).json()) as { id: string; key: string; prefix: string; permission: string };
    expect(created.key).toBeTruthy();
    expect(created.permission).toBe('read');

    const listed = (await (await api(`/user/repos/${OWNER}/${REPO}/keys`)).json()) as {
      keys: Array<{ id: string; tokenPrefix: string } & Record<string, unknown>>;
    };
    expect(listed.keys.map((k) => k.id)).toContain(created.id);
    // Secret itself must never appear in lists.
    expect(JSON.stringify(listed.keys)).not.toContain(created.key);

    const fetchPath = `/${OWNER}/${REPO}/info/refs?service=git-upload-pack`;
    expect((await api(fetchPath)).status).toBe(401);
    expect((await api(fetchPath, { headers: basicAuthHeader('git', created.key) })).status).toBe(200);

    const pushPath = `/${OWNER}/${REPO}/info/refs?service=git-receive-pack`;
    const denied = await api(pushPath, { headers: basicAuthHeader('git', created.key) });
    expect([401, 403].includes(denied.status)).toBe(true);
  });

  it('revokes the key and git access stops', async () => {
    const created = (await (
      await api(`/user/repos/${OWNER}/${REPO}/keys`, json({ method: 'POST', body: JSON.stringify({ name: 'revoke-me' }) }))
    ).json()) as { id: string; key: string };
    const fetchPath = `/${OWNER}/${REPO}/info/refs?service=git-upload-pack`;
    expect((await api(fetchPath, { headers: basicAuthHeader('git', created.key) })).status).toBe(200);
    expect((await api(`/user/repos/${OWNER}/${REPO}/keys/${created.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(fetchPath, { headers: basicAuthHeader('git', created.key) })).status).toBe(401);
  });
});
