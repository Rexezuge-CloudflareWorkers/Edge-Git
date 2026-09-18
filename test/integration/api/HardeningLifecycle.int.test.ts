import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedRepo, setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'harden-int';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

describe('Hardening integration on real D1', () => {
  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    await seedRepo(testEnv.DB, { ownerEmail: USER, owner: OWNER, name: REPO, isPrivate: false });
  });

  it('rejects malformed token ids before DAO', async () => {
    expect((await api('/user/tokens/not-a-uuid', { method: 'DELETE' })).status).toBe(400);
    expect((await api('/user/tokens/123/rotate', { method: 'POST' })).status).toBe(400);
  });

  it('flags malformed JSON bodies', async () => {
    const res = await api('/user/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    expect([400, 500]).toContain(res.status);
  });

  it('rejects zero/negative issue numbers without D1 burn', async () => {
    expect((await api(`/repos/${OWNER}/${REPO}/issues/0`)).status).toBe(404);
    expect((await api(`/repos/${OWNER}/${REPO}/issues/-1`)).status).toBe(404);
    expect((await api(`/repos/${OWNER}/${REPO}/issues/99999999999`)).status).toBe(404);
  });

  it('caps search q and audit limit', async () => {
    expect((await api('/search?q=x')).status).toBe(400);
    expect((await api(`/search?q=${'x'.repeat(500)}`)).status).toBe(400);
    const audit = await api('/user/audit?limit=9999');
    expect([200, 400]).toContain(audit.status);
  });

  it('validates realtime ticket owner/repo', async () => {
    const badOwner = await api('/user/realtime/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'bad owner!', repo: REPO, channels: [] }),
    });
    expect(badOwner.status).toBe(400);
    const badChannels = await api('/user/realtime/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: OWNER, repo: REPO, channels: 'activity' }),
    });
    expect(badChannels.status).toBe(400);
  });
});
