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

function b64(text: string): string {
  return btoa(text);
}

describe('username rename on real D1', () => {
  beforeAll(async () => {
    await setupIntegrationTest(env as unknown as TestEnv, USER);
    const created = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name: REPO }) }));
    expect(created.status).toBe(201);
    // Seed git content + an issue so the rename has something to move.
    const written = await api(
      `/user/repos/${OWNER}/${REPO}/contents`,
      json({
        method: 'POST',
        body: JSON.stringify({ branch: 'main', path: 'README.md', contentBase64: b64('hello rename'), message: 'Add README' }),
      }),
    );
    expect([200, 201]).toContain(written.status);
    const issue = await api(
      `/user/repos/${OWNER}/${REPO}/issues`,
      json({ method: 'POST', body: JSON.stringify({ title: 'Rename me', body: 'sidecar' }) }),
    );
    expect(issue.status).toBe(201);
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

    // DO move: git history survived under the new owner, old isolate is gone.
    const branches = (await (await api(`/repos/${next}/${REPO}/branches`)).json()) as { branches: string[] };
    expect(branches.branches).toContain('main');
    expect((await api(`/repos/${next}/${REPO}/blob?ref=main&path=README.md`)).status).toBe(200);
    expect((await api(`/repos/${OWNER}/${REPO}/branches`)).status).toBe(404);

    // Rename follows through: the computed issue full_name reflects the new owner.
    const db = (env as unknown as TestEnv).DB;
    const issue = (await db
      .prepare("SELECT (SELECT owner || '/' || name FROM repositories WHERE id = issues.repository_id) AS full_name FROM issues WHERE title = ?")
      .bind('Rename me')
      .first<{ full_name: string }>()) as {
      full_name: string;
    };
    expect(issue.full_name).toBe(`${next}/${REPO}`);

    // Profile lookup follows the new handle.
    expect((await api(`/users/${next}`)).status).toBe(200);
  });

  it('is idempotent for the current handle', async () => {
    const res = await api('/user/me/username', json({ method: 'PATCH', body: JSON.stringify({ username: 'renamed-owner' }) }));
    expect(res.status).toBe(200);
  });
});
