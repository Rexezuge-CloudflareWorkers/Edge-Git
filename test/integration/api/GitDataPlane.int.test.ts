import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'git-data-plane';

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

describe('git data-plane on real D1+DO', () => {
  beforeAll(async () => {
    await setupIntegrationTest(env as unknown as TestEnv, USER);
    const created = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name: REPO }) }));
    expect(created.status).toBe(201);
  });

  it('writes a file via the editor (201 on create)', async () => {
    const res = await api(
      `/user/repos/${OWNER}/${REPO}/contents`,
      json({
        method: 'POST',
        body: JSON.stringify({ branch: 'main', path: 'README.md', contentBase64: b64('hello edge-git'), message: 'Add README' }),
      }),
    );
    expect(res.status).toBe(201);
  });

  it('serves branches/tree/blob/commits read-model from the DO', async () => {
    const branches = (await (await api(`/repos/${OWNER}/${REPO}/branches`)).json()) as { branches: string[] };
    expect(branches.branches).toContain('main');

    const tree = await api(`/repos/${OWNER}/${REPO}/tree?ref=main`);
    expect(tree.status).toBe(200);

    const blob = await api(`/repos/${OWNER}/${REPO}/blob?ref=main&path=README.md`);
    expect(blob.status).toBe(200);

    const commits = (await (await api(`/repos/${OWNER}/${REPO}/commits?ref=main`)).json()) as unknown;
    expect(Array.isArray(commits) || (commits !== null && typeof commits === 'object')).toBe(true);

    const authed = await api(`/user/repos/${OWNER}/${REPO}/commits?ref=main`);
    expect(authed.status).toBe(200);
  });

  it('updates the same file (200) and rejects unsafe paths', async () => {
    const again = await api(
      `/user/repos/${OWNER}/${REPO}/contents`,
      json({
        method: 'POST',
        body: JSON.stringify({ branch: 'main', path: 'README.md', contentBase64: b64('second revision'), message: 'Update README' }),
      }),
    );
    expect(again.status).toBe(200);

    const traversal = await api(
      `/user/repos/${OWNER}/${REPO}/contents`,
      json({
        method: 'POST',
        body: JSON.stringify({ branch: 'main', path: '../escape', contentBase64: b64('x') }),
      }),
    );
    expect(traversal.status).toBe(400);
  });

  it('rejects invalid git service and oversized bodies with 400/413', async () => {
    expect((await api(`/${OWNER}/${REPO}/info/refs?service=nope`)).status).toBe(400);

    const bigFetch = await api(`/${OWNER}/${REPO}/git-upload-pack`, {
      method: 'POST',
      headers: { 'Content-Length': String(2 * 1024 * 1024), 'Content-Type': 'application/x-git-upload-pack-request' },
      body: 'x',
    });
    expect(bigFetch.status).toBe(413);

    // Anon push never reaches the size gate (401 first — no existence oracle).
    const anonPush = await api(`/${OWNER}/${REPO}/git-receive-pack`, {
      method: 'POST',
      headers: { 'Content-Length': String(60 * 1024 * 1024), 'Content-Type': 'application/x-git-receive-pack-request' },
      body: 'x',
    });
    expect(anonPush.status).toBe(401);

    // Authed oversized push hits the 413 pack gate.
    const minted = (await (
      await api('/user/tokens', json({ method: 'POST', body: JSON.stringify({ name: 'push-size-probe' }) }))
    ).json()) as { token: string };
    const bigPush = await api(`/${OWNER}/${REPO}/git-receive-pack`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${minted.token}`, 'Content-Length': String(60 * 1024 * 1024), 'Content-Type': 'application/x-git-receive-pack-request' },
      body: 'x',
    });
    expect(bigPush.status).toBe(413);
  });
});
