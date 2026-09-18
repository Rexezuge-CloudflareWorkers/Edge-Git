import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'crud-demo';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(init?: RequestInit): RequestInit {
  return { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } };
}

describe('repo CRUD on real D1', () => {
  beforeAll(async () => {
    await setupIntegrationTest(env as unknown as TestEnv, USER);
  });

  it('creates a repo via the API', async () => {
    const res = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name: REPO, description: 'CRUD Repo' }) }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; owner: string; name: string; fullName: string };
    expect(body.id).toBeTruthy();
    expect(body).toMatchObject({ owner: OWNER, name: REPO, fullName: `${OWNER}/${REPO}` });
  });

  it('reads the repo back (owner view + public read)', async () => {
    const owned = await api(`/user/repos/${OWNER}/${REPO}`);
    expect(owned.status).toBe(200);
    const ownedBody = (await owned.json()) as { description: string; viewerCanManage: boolean };
    expect(ownedBody).toMatchObject({ description: 'CRUD Repo', viewerCanManage: true });

    const listed = (await (await api('/user/repos')).json()) as { repos: Array<{ name: string }> };
    expect(listed.repos.map((r) => r.name)).toContain(REPO);

    const pub = await api(`/repos/${OWNER}/${REPO}`);
    expect(pub.status).toBe(200);
  });

  it('updates the description as owner', async () => {
    const res = await api(
      `/user/repos/${OWNER}/${REPO}`,
      json({ method: 'PATCH', body: JSON.stringify({ description: 'Updated' }) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { description: string };
    expect(body.description).toBe('Updated');
  });

  it('deletes the repo and it stays gone', async () => {
    const res = await api(`/user/repos/${OWNER}/${REPO}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await api(`/user/repos/${OWNER}/${REPO}`)).status).toBe(404);
    expect((await api(`/repos/${OWNER}/${REPO}`)).status).toBe(404);
  });

  it('recreates a deleted repo name without orphaning the DO', async () => {
    // Regression: `deleteRepo` used `storage.deleteAll()`, wiping the dofs
    // schema on the warm DO isolate, so recreating the same name 500'd with
    // `no such table: dofs_files` while the D1 row was already committed.
    const name = 'crud-recreate';
    const created = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name }) }));
    expect(created.status).toBe(201);
    const deleted = await api(`/user/repos/${OWNER}/${name}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    const recreated = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name }) }));
    expect(recreated.status).toBe(201);
    const body = (await recreated.json()) as { fullName: string };
    expect(body.fullName).toBe(`${OWNER}/${name}`);
    expect((await api(`/repos/${OWNER}/${name}`)).status).toBe(200);
    const refs = await api(`/${OWNER}/${name}/info/refs?service=git-upload-pack`);
    expect(refs.status).toBe(200);
    expect(refs.headers.get('content-type')).toContain('x-git-upload-pack-advertisement');
  });

  it('rejects invalid creates and unknown repos', async () => {
    const missing = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({}) }));
    expect(missing.status).toBe(400);
    expect((await api(`/user/repos/${OWNER}/nope`)).status).toBe(404);
  });
});
