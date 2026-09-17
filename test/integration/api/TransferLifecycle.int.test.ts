import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedRepo, setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO_A = 'transfer-a';
const REPO_B = 'transfer-b';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(init?: RequestInit & { body?: unknown }): RequestInit {
  return { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }, body: JSON.stringify((init as { body?: unknown })?.body ?? {}) };
}

describe('transfer + hardening lifecycle on real D1', () => {
  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    await seedRepo(testEnv.DB, { ownerEmail: USER, owner: OWNER, name: REPO_A, isPrivate: true });
    await seedRepo(testEnv.DB, { ownerEmail: USER, owner: OWNER, name: REPO_B, isPrivate: true });
  });

  it('rejects bad import URLs and tracks jobs', async () => {
    const bad = await api(`/user/repos/${OWNER}/${REPO_A}/import`, json({ method: 'POST', body: { sourceUrl: 'http://evil.local/x' } }));
    expect(bad.status).toBe(400);

    // .invalid never resolves: the async attempt fails fast without
    // affecting the 202 response.
    const started = await api(`/user/repos/${OWNER}/${REPO_A}/import`, json({ method: 'POST', body: { sourceUrl: 'https://example.invalid/o/r' } }));
    expect(started.status).toBe(202);
    const created = (await started.json()) as { job: { id: string; sourceUrl: string; status: string } };
    expect(created.job.sourceUrl).toBe('https://example.invalid/o/r');

    const second = await api(`/user/repos/${OWNER}/${REPO_A}/import`, json({ method: 'POST', body: { sourceUrl: 'https://example.invalid/o/other' } }));
    expect([202, 400]).toContain(second.status);

    const current = (await (await api(`/user/repos/${OWNER}/${REPO_A}/import`)).json()) as { job: { id: string; status: string } };
    expect(current.job.id).toBeTruthy();
    const cancel = await api(`/user/repos/${OWNER}/${REPO_A}/import/${current.job.id}/cancel`, { method: 'POST' });
    // 200 when the job was still active, 400 when it already reached a
    // terminal state — both prove the state machine responds.
    expect([200, 400]).toContain(cancel.status);
  });

  it('configures, toggles, and removes mirrors', async () => {
    const badInterval = await api(`/user/repos/${OWNER}/${REPO_A}/mirror`, json({ method: 'PUT', body: { sourceUrl: 'https://example.invalid/o/r', intervalMinutes: 61 } }));
    expect(badInterval.status).toBe(400);

    const put = await api(`/user/repos/${OWNER}/${REPO_A}/mirror`, json({ method: 'PUT', body: { sourceUrl: 'https://example.invalid/o/r', intervalMinutes: 60 } }));
    expect(put.status).toBe(200);
    const configured = (await put.json()) as { mirror: { sourceUrl: string; intervalMinutes: number; enabled: boolean } };
    expect(configured.mirror.sourceUrl).toBe('https://example.invalid/o/r');
    expect(configured.mirror.enabled).toBe(true);

    const fetched = (await (await api(`/user/repos/${OWNER}/${REPO_A}/mirror`)).json()) as { mirror: { intervalMinutes: number } };
    expect(fetched.mirror.intervalMinutes).toBe(60);

    const disabled = (await (await api(`/user/repos/${OWNER}/${REPO_A}/mirror/enable`, json({ method: 'POST', body: { enabled: false } }))).json()) as {
      mirror: { enabled: boolean };
    };
    expect(disabled.mirror.enabled).toBe(false);

    expect((await api(`/user/repos/${OWNER}/${REPO_A}/mirror`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(`/user/repos/${OWNER}/${REPO_A}/mirror`)).status).toBe(404);
  });

  it('mints deploy keys that unlock git and revoke cleanly', async () => {
    const created = (await (
      await api(`/user/repos/${OWNER}/${REPO_A}/keys`, json({ method: 'POST', body: { name: 'ci', permission: 'read' } }))
    ).json()) as { id: string; key: string; prefix: string };
    expect(created.key.length).toBeGreaterThan(20);
    expect(created.prefix).toBe(created.key.slice(0, 12));

    const listed = (await (await api(`/user/repos/${OWNER}/${REPO_A}/keys`)).json()) as { keys: Array<{ id: string; tokenPrefix: string | null }> };
    expect(listed.keys.map((k) => k.id)).toContain(created.id);
    expect(listed.keys.find((k) => k.id === created.id)?.tokenPrefix).toBe(created.prefix);

    const fetchPath = `/${OWNER}/${REPO_A}/info/refs?service=git-upload-pack`;
    expect((await api(fetchPath)).status).toBe(401);
    expect((await api(fetchPath, { headers: { Authorization: `Bearer ${created.key}` } })).status).toBe(200);
    // Read-only deploy keys cannot push.
    expect((await api(`/${OWNER}/${REPO_A}/info/refs?service=git-receive-pack`, { headers: { Authorization: `Bearer ${created.key}` } })).status).toBe(401);
    // Keys are scoped to their repo.
    expect((await api(`/${OWNER}/${REPO_B}/info/refs?service=git-upload-pack`, { headers: { Authorization: `Bearer ${created.key}` } })).status).toBe(401);

    expect((await api(`/user/repos/${OWNER}/${REPO_A}/keys/${created.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(fetchPath, { headers: { Authorization: `Bearer ${created.key}` } })).status).toBe(401);
  });

  it('serves security settings with warn default and allows block', async () => {
    const initial = (await (await api(`/user/repos/${OWNER}/${REPO_A}/security`)).json()) as { settings: { secretScanMode: string } };
    expect(initial.settings.secretScanMode).toBe('warn');

    const bad = await api(`/user/repos/${OWNER}/${REPO_A}/security`, json({ method: 'PATCH', body: { secretScanMode: 'nope' } }));
    expect(bad.status).toBe(400);

    const blocked = (await (await api(`/user/repos/${OWNER}/${REPO_A}/security`, json({ method: 'PATCH', body: { secretScanMode: 'block' } }))).json()) as {
      settings: { secretScanMode: string };
    };
    expect(blocked.settings.secretScanMode).toBe('block');

    const back = (await (await api(`/user/repos/${OWNER}/${REPO_A}/security`, json({ method: 'PATCH', body: { secretScanMode: 'warn' } }))).json()) as {
      settings: { secretScanMode: string };
    };
    expect(back.settings.secretScanMode).toBe('warn');
  });

  it('rotates PATs and enforces repo grants', async () => {
    const mint = (await (
      await api('/user/tokens', json({ method: 'POST', body: { name: 'rot-me' } }))
    ).json()) as { tokenId: string; token: string; prefix: string };
    expect(mint.prefix).toBe(mint.token.slice(0, 12));

    const fetchPath = `/${OWNER}/${REPO_A}/info/refs?service=git-upload-pack`;
    expect((await api(fetchPath, { headers: { Authorization: `Bearer ${mint.token}` } })).status).toBe(200);

    const rotated = (await (await api(`/user/tokens/${mint.tokenId}/rotate`, { method: 'POST' })).json()) as { token: string; expiresAt: number };
    expect(rotated.token).toBeTruthy();
    expect(rotated.token).not.toBe(mint.token);
    expect((await api(fetchPath, { headers: { Authorization: `Bearer ${mint.token}` } })).status).toBe(401);
    expect((await api(fetchPath, { headers: { Authorization: `Bearer ${rotated.token}` } })).status).toBe(200);

    const listed = (await (await api('/user/tokens')).json()) as { tokens: Array<{ tokenId: string; tokenPrefix: string | null }> };
    expect(listed.tokens.find((t) => t.tokenId === mint.tokenId)?.tokenPrefix).toBe(rotated.token.slice(0, 12));

    const scoped = (await (
      await api('/user/tokens', json({ method: 'POST', body: { name: 'scoped', repoGrants: [{ owner: OWNER, name: REPO_A, scope: 'repo:read' }] } }))
    ).json()) as { token: string };
    expect((await api(`/${OWNER}/${REPO_A}/info/refs?service=git-upload-pack`, { headers: { Authorization: `Bearer ${scoped.token}` } })).status).toBe(200);
    // Read grant: push advertise is forbidden …
    expect((await api(`/${OWNER}/${REPO_A}/info/refs?service=git-receive-pack`, { headers: { Authorization: `Bearer ${scoped.token}` } })).status).toBe(403);
    // … and repos outside the grant set hide their existence.
    expect((await api(`/${OWNER}/${REPO_B}/info/refs?service=git-upload-pack`, { headers: { Authorization: `Bearer ${scoped.token}` } })).status).toBe(401);

    const badGrant = await api('/user/tokens', json({ method: 'POST', body: { name: 'bad-grant', repoGrants: [{ owner: 'nobody', name: 'missing', scope: 'repo:read' }] } }));
    expect(badGrant.status).toBe(404);
  });
});
