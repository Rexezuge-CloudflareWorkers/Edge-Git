import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { addCollaborator, basicAuthHeader, bearerHeader, ensureUser, mintPatForEmail, setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const PUB = 'perm-pub';
const PRIV = 'perm-priv';
const SECOND = 'second@example.com';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(init?: RequestInit): RequestInit {
  return { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } };
}

describe('permission matrix on real D1 (git trust boundary)', () => {
  let secondToken = '';

  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    await ensureUser(testEnv.DB, SECOND, 'second');
    for (const [name, isPrivate] of [
      [PUB, false],
      [PRIV, true],
    ] as const) {
      const res = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name, isPrivate }) }));
      expect([200, 201].includes(res.status)).toBe(true);
    }
    secondToken = (await mintPatForEmail(testEnv.DB, SECOND)).token;
  });

  it('hides private repos from anonymous git (401, not 404)', async () => {
    expect((await api(`/${OWNER}/${PUB}/info/refs?service=git-upload-pack`)).status).toBe(200);
    expect((await api(`/${OWNER}/${PRIV}/info/refs?service=git-upload-pack`)).status).toBe(401);
    expect((await api(`/${OWNER}/${PRIV}/info/refs?service=git-receive-pack`)).status).toBe(401);
  });

  it('grants second-user PAT public fetch but hides private without a grant', async () => {
    expect((await api(`/${OWNER}/${PUB}/info/refs?service=git-upload-pack`, { headers: bearerHeader(secondToken) })).status).toBe(200);
    expect((await api(`/${OWNER}/${PRIV}/info/refs?service=git-upload-pack`, { headers: bearerHeader(secondToken) })).status).toBe(401);
  });

  it('accepts the same PAT via Basic (password) credentials', async () => {
    const res = await api(`/${OWNER}/${PUB}/info/refs?service=git-upload-pack`, { headers: basicAuthHeader('second', secondToken) });
    expect(res.status).toBe(200);
    const denied = await api(`/${OWNER}/${PRIV}/info/refs?service=git-upload-pack`, { headers: basicAuthHeader('second', secondToken) });
    expect(denied.status).toBe(401);
  });

  it('elevates the collaborator read → write via git gates', async () => {
    const testEnv = env as unknown as TestEnv;
    const repoRow = (await testEnv.DB.prepare(`SELECT id FROM repositories WHERE owner_ci = ? AND name_ci = ?`)
      .bind(OWNER, PRIV)
      .first()) as unknown as {
      id: string;
    };
    await addCollaborator(testEnv.DB, repoRow.id, SECOND, 'read', USER);

    const fetchPath = `/${OWNER}/${PRIV}/info/refs?service=git-upload-pack`;
    const pushPath = `/${OWNER}/${PRIV}/info/refs?service=git-receive-pack`;
    expect((await api(fetchPath, { headers: bearerHeader(secondToken) })).status).toBe(200);
    // Read grant authenticates but cannot push.
    expect((await api(pushPath, { headers: bearerHeader(secondToken) })).status).toBe(403);

    await addCollaborator(testEnv.DB, repoRow.id, SECOND, 'write', USER);
    expect((await api(pushPath, { headers: bearerHeader(secondToken) })).status).toBe(200);
  });

  it('enforces PAT scope gates (read-only cannot push)', async () => {
    const testEnv = env as unknown as TestEnv;
    const readOnly = await mintPatForEmail(testEnv.DB, USER, { name: 'matrix-read', scopes: ['repo:read'] });
    expect((await api(`/${OWNER}/${PRIV}/info/refs?service=git-upload-pack`, { headers: bearerHeader(readOnly.token) })).status).toBe(200);
    expect((await api(`/${OWNER}/${PRIV}/info/refs?service=git-receive-pack`, { headers: bearerHeader(readOnly.token) })).status).toBe(403);
  });

  it('manages collaborators as owner and revokes back to hidden', async () => {
    const testEnv = env as unknown as TestEnv;
    const put = await api(
      `/user/repos/${OWNER}/${PRIV}/collaborators/second`,
      json({ method: 'PUT', body: JSON.stringify({ role: 'read' }) }),
    );
    expect([200, 201].includes(put.status)).toBe(true);

    const listed = (await (await api(`/user/repos/${OWNER}/${PRIV}/collaborators`)).json()) as {
      collaborators: Array<{ username: string; role: string }>;
    };
    expect(listed.collaborators.map((c) => c.username)).toContain('second');
    expect(listed.collaborators.every((c) => !('email' in c))).toBe(true);

    expect((await api(`/user/repos/${OWNER}/${PRIV}/collaborators/second`, { method: 'DELETE' })).status).toBe(200);
    const relisted = (await (await api(`/user/repos/${OWNER}/${PRIV}/collaborators`)).json()) as {
      collaborators: Array<{ username: string }>;
    };
    expect(relisted.collaborators.map((c) => c.username)).not.toContain('second');
    expect((await api(`/${OWNER}/${PRIV}/info/refs?service=git-upload-pack`, { headers: bearerHeader(secondToken) })).status).toBe(401);
  });
});
