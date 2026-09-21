import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

describe('audit readers on real D1', () => {
  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    // Seed a personal audit row directly (activityAudit fan-out is
    // `waitUntil` best-effort; the reader contract is what's asserted here).
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare(
      `INSERT OR IGNORE INTO audit_logs (log_id, timestamp, user_email, action, resource, method, path, status_code, detail, ip_address, user_agent, org_id, repo_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind('audit-seed-1', now, USER.toLowerCase(), 'repo.list', null, 'GET', '/user/repos', 200, null, null, null, null, null, now)
      .run();
    // Exercise the live middleware path too (best-effort recording).
    await api('/user/me');
  });

  it('lists personal audit trail with cursor shape', async () => {
    const res = await api('/user/audit?limit=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: Array<{ username: string; action: string }>; nextCursor: string | null };
    expect(Array.isArray(body.logs)).toBe(true);
    expect(body.logs.length).toBeGreaterThan(0);
    // Seeded row is present (live `activityAudit` rows may sort first).
    // Email stays the store key; the API exposes only the current username.
    expect(body.logs).toContainEqual(expect.objectContaining({ username: 'test', action: 'repo.list' }));
    expect(body.logs.every((l) => !('userEmail' in l) && !('user_email' in l))).toBe(true);
    expect('nextCursor' in body).toBe(true);
  });

  it('rejects org audit for non-owners', async () => {
    // No org exists / caller is not an owner → 403 or 404, never 200 leak.
    const res = await api('/user/orgs/acme/audit');
    expect([403, 404].includes(res.status)).toBe(true);
  });
});
