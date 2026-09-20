import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedRepo, setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'numbering-demo';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function postJson(path: string, body: unknown): Promise<Response> {
  return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('atomic numbering on real D1 (migration 0020)', () => {
  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    await seedRepo(testEnv.DB, { ownerEmail: USER, owner: OWNER, name: REPO });
  });

  it('hands out distinct issue numbers under concurrent POSTs', async () => {
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, i) => postJson(`/user/repos/${OWNER}/${REPO}/issues`, { title: `Race ${i}` })),
    );
    for (const res of responses) expect(res.status).toBe(201);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{ number: number }>;
    const numbers = bodies.map((b) => b.number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(5);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });

  it('seeds project counters above pre-existing rows', async () => {
    const first = await postJson(`/user/repos/${OWNER}/${REPO}/projects`, { title: 'Board One' });
    expect(first.status).toBe(201);
    const second = await postJson(`/user/repos/${OWNER}/${REPO}/projects`, { title: 'Board Two' });
    expect(second.status).toBe(201);
    const a = (await first.json()) as { project: { number: number } };
    const b = (await second.json()) as { project: { number: number } };
    expect(new Set([a.project.number, b.project.number]).size).toBe(2);
  });
});
