import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedRepo, setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'token-priv';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

describe('PAT lifecycle on real D1', () => {
  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    await seedRepo(testEnv.DB, { ownerEmail: USER, owner: OWNER, name: REPO, isPrivate: true });
  });

  it('creates and lists a token', async () => {
    const res = await api('/user/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ci-token' }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { tokenId: string; token: string; name: string };
    expect(created.tokenId).toBeTruthy();
    expect(created.token).toBeTruthy();

    const listed = (await (await api('/user/tokens')).json()) as { tokens: Array<{ tokenId: string; name: string }> };
    expect(listed.tokens.map((t) => t.tokenId)).toContain(created.tokenId);
  });

  it('gates a private repo behind the PAT', async () => {
    const path = `/${OWNER}/${REPO}/info/refs?service=git-upload-pack`;
    expect((await api(path)).status).toBe(401);
    expect((await api(path, { headers: { Authorization: 'Bearer bogus' } })).status).toBe(401);

    const created = (await (await api('/user/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pat-check' }),
    })).json()) as { tokenId: string; token: string };

    const authed = await api(path, { headers: { Authorization: `Bearer ${created.token}` } });
    expect(authed.status).toBe(200);
  });

  it('revokes the token and the PAT stops working', async () => {
    const created = (await (await api('/user/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'revoke-me' }),
    })).json()) as { tokenId: string; token: string };

    const path = `/${OWNER}/${REPO}/info/refs?service=git-upload-pack`;
    expect((await api(path, { headers: { Authorization: `Bearer ${created.token}` } })).status).toBe(200);

    expect((await api(`/user/tokens/${created.tokenId}`, { method: 'DELETE' })).status).toBe(200);
    const listed = (await (await api('/user/tokens')).json()) as { tokens: Array<{ tokenId: string }> };
    expect(listed.tokens.map((t) => t.tokenId)).not.toContain(created.tokenId);
    expect((await api(path, { headers: { Authorization: `Bearer ${created.token}` } })).status).toBe(401);
  });
});
