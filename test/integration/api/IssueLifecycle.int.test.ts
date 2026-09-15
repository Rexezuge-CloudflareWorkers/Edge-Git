import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedRepo, setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'issue-demo';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function postIssue(title: string | undefined): Promise<Response> {
  return api(`/user/repos/${OWNER}/${REPO}/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(title === undefined ? {} : { title }),
  });
}

describe('issue lifecycle on real D1', () => {
  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    await seedRepo(testEnv.DB, { ownerEmail: USER, owner: OWNER, name: REPO });
  });

  it('numbers issues per repo', async () => {
    const first = await postIssue('First Bug');
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ number: 1 });

    const second = await postIssue('Second Bug');
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ number: 2 });
  });

  it('lists newest first (owner + public)', async () => {
    const owned = (await (await api(`/user/repos/${OWNER}/${REPO}/issues`)).json()) as {
      issues: Array<{ number: number; title: string }>;
    };
    expect(owned.issues.map((i) => i.number)).toEqual([2, 1]);
    expect(owned.issues.map((i) => i.title)).toEqual(['Second Bug', 'First Bug']);

    const pub = await api(`/repos/${OWNER}/${REPO}/issues`);
    expect(pub.status).toBe(200);
    const pubBody = (await pub.json()) as { issues: unknown[] };
    expect(pubBody.issues).toHaveLength(2);
  });

  it('validates title and repo existence', async () => {
    expect((await postIssue(undefined)).status).toBe(400);
    const missing = await api(`/user/repos/${OWNER}/nope/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Lost' }),
    });
    expect(missing.status).toBe(404);
  });
});
