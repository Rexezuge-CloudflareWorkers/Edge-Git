import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const ORG = 'rename-org';
const NEXT = 'renamed-org';
const REPO = 'org-rename-cascade';

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

describe('org rename on real D1+DO', () => {
  beforeAll(async () => {
    await setupIntegrationTest(env as unknown as TestEnv, USER);
    const created = await api('/user/orgs', json({ method: 'POST', body: JSON.stringify({ username: ORG }) }));
    expect(created.status).toBe(201);
    const repo = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name: REPO, owner: ORG }) }));
    expect(repo.status).toBe(201);
    // Seed git content + an issue so the rename has something to move.
    const written = await api(
      `/user/repos/${ORG}/${REPO}/contents`,
      json({
        method: 'POST',
        body: JSON.stringify({ branch: 'main', path: 'README.md', contentBase64: b64('hello org rename'), message: 'Add README' }),
      }),
    );
    expect([200, 201]).toContain(written.status);
    const issue = await api(
      `/user/repos/${ORG}/${REPO}/issues`,
      json({ method: 'POST', body: JSON.stringify({ title: 'Org rename me', body: 'sidecar' }) }),
    );
    expect(issue.status).toBe(201);
  });

  it('renames and moves org repos to the new owner', async () => {
    const res = await api(`/user/orgs/${ORG}`, json({ method: 'PATCH', body: JSON.stringify({ username: NEXT }) }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; username: string };
    expect(body.username).toBe(NEXT);

    // D1 cascade: the repo moved to the new owner namespace.
    expect((await api(`/user/repos/${NEXT}/${REPO}`)).status).toBe(200);
    expect((await api(`/user/repos/${ORG}/${REPO}`)).status).toBe(404);

    // DO move: git history survived under the new owner, old isolate is gone.
    const branches = (await (await api(`/repos/${NEXT}/${REPO}/branches`)).json()) as { branches: string[] };
    expect(branches.branches).toContain('main');
    expect((await api(`/repos/${NEXT}/${REPO}/blob?ref=main&path=README.md`)).status).toBe(200);
    expect((await api(`/repos/${ORG}/${REPO}/branches`)).status).toBe(404);

    // Rename follows through: the computed issue full_name reflects the new owner.
    const db = (env as unknown as TestEnv).DB;
    const issue = (await db
      .prepare(
        "SELECT (SELECT owner || '/' || name FROM repositories WHERE id = issues.repository_id) AS full_name FROM issues WHERE title = ?",
      )
      .bind('Org rename me')
      .first<{ full_name: string }>()) as { full_name: string };
    expect(issue.full_name).toBe(`${NEXT}/${REPO}`);
  });
});
