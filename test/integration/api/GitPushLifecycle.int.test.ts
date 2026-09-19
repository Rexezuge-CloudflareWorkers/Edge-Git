import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'push-live';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(init?: RequestInit): RequestInit {
  return { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } };
}

function b64(text: string): string {
  return btoa(text);
}

describe('git push lifecycle on real D1+DO', () => {
  beforeAll(async () => {
    await setupIntegrationTest(env as unknown as TestEnv, USER);
    const created = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name: REPO }) }));
    expect([200, 201]).toContain(created.status);
    const seeded = await api(
      `/user/repos/${OWNER}/${REPO}/contents`,
      json({
        method: 'POST',
        body: JSON.stringify({ branch: 'main', path: 'README.md', contentBase64: b64('hello push-live'), message: 'Init' }),
      }),
    );
    expect([200, 201]).toContain(seeded.status);
  });

  it('advertises upload-pack refs and answers a small fetch', async () => {
    const refs = await api(`/${OWNER}/${REPO}/info/refs?service=git-upload-pack`);
    expect(refs.status).toBe(200);
    const text = await refs.text();
    expect(text.length).toBeGreaterThan(0);

    const fetch = await api(`/${OWNER}/${REPO}/git-upload-pack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-git-upload-pack-request' },
      body: '0000',
    });
    expect([200, 400]).toContain(fetch.status);
  });

  it('rejects anon pushes and oversized authed packs', async () => {
    const anonPush = await api(`/${OWNER}/${REPO}/git-receive-pack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-git-receive-pack-request' },
      body: 'x',
    });
    expect(anonPush.status).toBe(401);

    const minted = (await (
      await api('/user/tokens', json({ method: 'POST', body: JSON.stringify({ name: 'push-live-probe' }) }))
    ).json()) as { token: string };
    expect(typeof minted.token).toBe('string');

    const bigPush = await api(`/${OWNER}/${REPO}/git-receive-pack`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${minted.token}`,
        'Content-Length': String(60 * 1024 * 1024),
        'Content-Type': 'application/x-git-receive-pack-request',
      },
      body: 'x',
    });
    expect(bigPush.status).toBe(413);
  });

  it('enforces requirePr protection on web writes to main', async () => {
    const ruled = await api(
      `/user/repos/${OWNER}/${REPO}/rules`,
      json({ method: 'POST', body: JSON.stringify({ pattern: 'main', requirePr: true }) }),
    );
    expect([200, 201]).toContain(ruled.status);

    const blocked = await api(
      `/user/repos/${OWNER}/${REPO}/contents`,
      json({
        method: 'POST',
        body: JSON.stringify({ branch: 'main', path: 'direct.txt', contentBase64: b64('nope'), message: 'Direct' }),
      }),
    );
    expect(blocked.status).toBe(403);
  });
});
