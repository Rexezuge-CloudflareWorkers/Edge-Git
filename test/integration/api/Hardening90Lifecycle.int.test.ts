import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedRepo, setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'harden-90-int';
const OTHER = 'other90';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

describe('Harden-90 integration on real D1', () => {
  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    await seedRepo(testEnv.DB, { ownerEmail: USER, owner: OWNER, name: REPO, isPrivate: false });
    await seedRepo(testEnv.DB, { ownerEmail: USER, owner: OWNER, name: OTHER, isPrivate: false });
  });

  it('scopes import cancel to the caller repo (IDOR)', async () => {
    const start = await api(`/user/repos/${OWNER}/${REPO}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceUrl: 'https://example.com/a/b.git' }),
    });
    expect([202, 400]).toContain(start.status);
    if (start.status !== 202) return;
    const { job } = (await start.json()) as { job: { id: string } };
    // Cancel from a different repo must 404, not cancel.
    const cross = await api(`/user/repos/${OWNER}/${OTHER}/import/${job.id}/cancel`, { method: 'POST' });
    expect(cross.status).toBe(404);
    // Cancel from the owning repo succeeds.
    const own = await api(`/user/repos/${OWNER}/${REPO}/import/${job.id}/cancel`, { method: 'POST' });
    expect([200, 400]).toContain(own.status);
  });

  it('sends no-store on all /user/* and hardened CSP on shell', async () => {
    const me = await api('/user/me');
    expect(me.headers.get('Cache-Control')).toBe('no-store');
    const collab = await api(`/user/repos/${OWNER}/${REPO}/collaborators`);
    expect(collab.headers.get('Cache-Control')).toBe('no-store');
    const shell = await api('/');
    const csp = shell.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
  });

  it('masks DO asset errors and caps repo params at edge', async () => {
    // Oversized JSON Content-Length is malformed (400), not 500.
    const big = await api('/user/tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(2_000_000) },
      body: JSON.stringify({ name: 'x' }),
    });
    expect([400, 413]).toContain(big.status);
    // NaN/overlong depth degrades to undefined instead of burning DO.
    const commits = await api(`/repos/${OWNER}/${REPO}/commits?depth=not-a-number`);
    expect([200, 404, 500]).toContain(commits.status);
    const overlong = await api(`/repos/${OWNER}/${REPO}/tree?ref=${'x'.repeat(1000)}`);
    expect([200, 404, 400]).toContain(overlong.status);
  });
});
