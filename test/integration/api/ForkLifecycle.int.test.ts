import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const SRC = 'fork-src';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(init?: RequestInit): RequestInit {
  return { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } };
}

describe('fork lifecycle on real D1', () => {
  beforeAll(async () => {
    await setupIntegrationTest(env as unknown as TestEnv, USER);
    const res = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name: SRC }) }));
    expect(res.status).toBe(201);
  });

  it('forks with an explicit owner and name', async () => {
    const res = await api(`/user/repos/${OWNER}/${SRC}/forks`, json({ method: 'POST', body: JSON.stringify({ owner: OWNER, name: 'fork-dst' }) }));
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ owner: OWNER, name: 'fork-dst', fullName: `${OWNER}/fork-dst`, forkedFrom: `${OWNER}/${SRC}` });
  });

  it('exposes lineage, fork listing, and counts', async () => {
    const fork = (await (await api(`/repos/${OWNER}/fork-dst`)).json()) as { forkedFrom: string; forksCount: number };
    expect(fork.forkedFrom).toBe(`${OWNER}/${SRC}`);

    const src = (await (await api(`/repos/${OWNER}/${SRC}`)).json()) as { forksCount: number; forkedFrom: null };
    expect(src.forksCount).toBe(1);
    expect(src.forkedFrom).toBeNull();

    const listed = (await (await api(`/repos/${OWNER}/${SRC}/forks`)).json()) as { count: number; forks: Array<{ fullName: string }> };
    expect(listed.count).toBe(1);
    expect(listed.forks.map((f) => f.fullName)).toContain(`${OWNER}/fork-dst`);

    const authed = (await (await api(`/user/repos/${OWNER}/${SRC}/forks`)).json()) as { count: number };
    expect(authed.count).toBe(1);
  });

  it('rejects forking into itself and unknown sources', async () => {
    const itself = await api(`/user/repos/${OWNER}/${SRC}/forks`, json({ method: 'POST', body: JSON.stringify({ owner: OWNER, name: SRC }) }));
    expect(itself.status).toBe(400);
    expect((await api(`/user/repos/${OWNER}/nope/forks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(404);
    expect((await api(`/repos/${OWNER}/nope/forks`)).status).toBe(404);
  });

  it('parses cross-fork PR selectors end to end', async () => {
    // Empty repos have no branches, so opening fails at branch resolution —
    // but the head repo selector itself is accepted and resolved (400, not 404).
    const cross = await api(
      `/user/repos/${OWNER}/${SRC}/pulls`,
      json({ method: 'POST', body: JSON.stringify({ title: 'From Fork', baseBranch: 'main', headBranch: 'main', headOwner: OWNER, headRepo: 'fork-dst' }) }),
    );
    expect(cross.status).toBe(400);

    const partial = await api(
      `/user/repos/${OWNER}/${SRC}/pulls`,
      json({ method: 'POST', body: JSON.stringify({ title: 'From Fork', baseBranch: 'main', headBranch: 'main', headOwner: OWNER }) }),
    );
    expect(partial.status).toBe(400);

    const unknownHead = await api(
      `/user/repos/${OWNER}/${SRC}/pulls`,
      json({ method: 'POST', body: JSON.stringify({ title: 'From Fork', baseBranch: 'main', headBranch: 'main', headOwner: OWNER, headRepo: 'nope' }) }),
    );
    expect(unknownHead.status).toBe(404);
  });
});
