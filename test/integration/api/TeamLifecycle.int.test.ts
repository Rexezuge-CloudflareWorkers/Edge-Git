import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { bearerHeader, ensureUser, mintPatForEmail, setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const ORG = 'teamorg';
const TEAM = 'core';
const REPO = 'team-repo';
const PRIV = 'team-priv';
const SECOND = 'second@example.com';
const THIRD = 'third@example.com';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(init?: RequestInit): RequestInit {
  return { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } };
}

describe('team lifecycle on real D1+DO', () => {
  let secondToken = '';

  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    await ensureUser(testEnv.DB, SECOND, 'second');
    await ensureUser(testEnv.DB, THIRD, 'third');
    const org = await api('/user/orgs', json({ method: 'POST', body: JSON.stringify({ username: ORG }) }));
    expect(org.status).toBe(201);
    const repo = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name: REPO, owner: ORG }) }));
    expect([200, 201].includes(repo.status)).toBe(true);
    secondToken = (await mintPatForEmail(testEnv.DB, SECOND)).token;
  });

  it('creates a team and rejects a missing slug', async () => {
    const res = await api(
      `/user/orgs/${ORG}/teams`,
      json({ method: 'POST', body: JSON.stringify({ slug: TEAM, name: 'Core' }) }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { slug: string; name: string };
    expect(body.slug).toBe(TEAM);
    expect(body.name).toBe('Core');

    const missing = await api(`/user/orgs/${ORG}/teams`, json({ method: 'POST', body: JSON.stringify({ name: 'No Slug' }) }));
    expect(missing.status).toBe(400);
  });

  it('manages team members (add, invalid role, list, promote, remove)', async () => {
    const testEnv = env as unknown as TestEnv;
    await ensureUser(testEnv.DB, SECOND, 'second');
    await ensureUser(testEnv.DB, THIRD, 'third');

    const add = await api(
      `/user/orgs/${ORG}/teams/${TEAM}/members`,
      json({ method: 'POST', body: JSON.stringify({ email: SECOND, role: 'member' }) }),
    );
    expect(add.status).toBe(201);

    const badRole = await api(
      `/user/orgs/${ORG}/teams/${TEAM}/members`,
      json({ method: 'POST', body: JSON.stringify({ email: THIRD, role: 'owner' }) }),
    );
    expect(badRole.status).toBe(400);

    const listed = (await (await api(`/user/orgs/${ORG}/teams/${TEAM}/members`)).json()) as {
      members: Array<{ email: string; role: string }>;
    };
    expect(listed.members.map((m) => m.email)).toContain(SECOND);

    const promoted = await api(
      `/user/orgs/${ORG}/teams/${TEAM}/members/${encodeURIComponent(SECOND)}`,
      json({ method: 'PATCH', body: JSON.stringify({ role: 'admin' }) }),
    );
    expect(promoted.status).toBe(200);

    // Last-team-admin guard: deleting/promoting-demoting the sole admin is a
    // 400, so add a second admin before removing `second`.
    const addThird = await api(
      `/user/orgs/${ORG}/teams/${TEAM}/members`,
      json({ method: 'POST', body: JSON.stringify({ email: THIRD, role: 'admin' }) }),
    );
    expect(addThird.status).toBe(201);

    const removed = await api(`/user/orgs/${ORG}/teams/${TEAM}/members/${encodeURIComponent(SECOND)}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);

    const relisted = (await (await api(`/user/orgs/${ORG}/teams/${TEAM}/members`)).json()) as {
      members: Array<{ email: string }>;
    };
    expect(relisted.members.map((m) => m.email)).not.toContain(SECOND);

    // Restore `second` for the grant/git test below.
    const restored = await api(
      `/user/orgs/${ORG}/teams/${TEAM}/members`,
      json({ method: 'POST', body: JSON.stringify({ email: SECOND, role: 'member' }) }),
    );
    expect(restored.status).toBe(201);
  });

  it('grants repos and verifies team-mediated git access', async () => {
    const grant = await api(
      `/user/orgs/${ORG}/teams/${TEAM}/repos/${ORG}/${REPO}`,
      json({ method: 'PUT', body: JSON.stringify({ role: 'read' }) }),
    );
    expect(grant.status).toBe(200);

    // `team-repo` is public, so exercise the git gate on a private repo.
    const priv = await api(
      '/user/repos',
      json({ method: 'POST', body: JSON.stringify({ name: PRIV, owner: ORG, isPrivate: true }) }),
    );
    expect([200, 201].includes(priv.status)).toBe(true);

    const grantRead = await api(
      `/user/orgs/${ORG}/teams/${TEAM}/repos/${ORG}/${PRIV}`,
      json({ method: 'PUT', body: JSON.stringify({ role: 'read' }) }),
    );
    expect(grantRead.status).toBe(200);

    const fetchPath = `/${ORG}/${PRIV}/info/refs?service=git-upload-pack`;
    const pushPath = `/${ORG}/${PRIV}/info/refs?service=git-receive-pack`;
    expect((await api(fetchPath, { headers: bearerHeader(secondToken) })).status).toBe(200);
    // Read grant authenticates but cannot push.
    expect((await api(pushPath, { headers: bearerHeader(secondToken) })).status).toBe(403);

    const elevate = await api(
      `/user/orgs/${ORG}/teams/${TEAM}/repos/${ORG}/${PRIV}`,
      json({ method: 'PUT', body: JSON.stringify({ role: 'write' }) }),
    );
    expect(elevate.status).toBe(200);
    expect((await api(pushPath, { headers: bearerHeader(secondToken) })).status).toBe(200);

    const grants = (await (await api(`/user/orgs/${ORG}/teams/${TEAM}/repos`)).json()) as {
      repos: Array<{ fullName: string | null; role: string }>;
    };
    expect(grants.repos.map((r) => r.fullName)).toContain(`${ORG}/${PRIV}`);

    const revoke = await api(`/user/orgs/${ORG}/teams/${TEAM}/repos/${ORG}/${PRIV}`, { method: 'DELETE' });
    expect(revoke.status).toBe(200);
  });

  it('guards the org last owner', async () => {
    const addOrg = await api(
      `/user/orgs/${ORG}/members`,
      json({ method: 'POST', body: JSON.stringify({ email: SECOND, role: 'member' }) }),
    );
    expect([200, 201].includes(addOrg.status)).toBe(true);

    const org = (await (await api(`/user/orgs/${ORG}`)).json()) as { viewerRole: string };
    expect(org.viewerRole).toBe('owner');

    const removeLastOwner = await api(`/user/orgs/${ORG}/members/${encodeURIComponent(USER)}`, { method: 'DELETE' });
    expect(removeLastOwner.status).toBe(400);
  });
});
