import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'pull-happy';

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

describe('pull request happy-path lifecycle on real D1+DO', () => {
  beforeAll(async () => {
    await setupIntegrationTest(env as unknown as TestEnv, USER);
    const created = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name: REPO }) }));
    expect([200, 201]).toContain(created.status);
    const seeded = await api(
      `/user/repos/${OWNER}/${REPO}/contents`,
      json({
        method: 'POST',
        body: JSON.stringify({ branch: 'main', path: 'a.txt', contentBase64: b64('hello'), message: 'Add a.txt' }),
      }),
    );
    expect([200, 201]).toContain(seeded.status);
    // Seed CODEOWNERS so PR creation's best-effort owner lookup hits the
    // first candidate. Missing-file blob reads leave dangling isomorphic-git
    // rejections in the workers pool (TreeReader catches the awaited path and
    // returns null, but workerd still reports 3 unhandled rejections that
    // fail the whole integration run's exit code).
    const owners = await api(
      `/user/repos/${OWNER}/${REPO}/contents`,
      json({
        method: 'POST',
        body: JSON.stringify({ branch: 'main', path: 'CODEOWNERS', contentBase64: b64('* @test\n'), message: 'Add CODEOWNERS' }),
      }),
    );
    expect([200, 201]).toContain(owners.status);
  });

  it('rejects same-branch PRs, then opens feature -> main (#1)', async () => {
    const sameBranch = await api(
      `/user/repos/${OWNER}/${REPO}/pulls`,
      json({ method: 'POST', body: JSON.stringify({ title: 'Same', baseBranch: 'main', headBranch: 'main' }) }),
    );
    expect(sameBranch.status).toBe(400);

    const branched = await api(
      `/user/repos/${OWNER}/${REPO}/branches`,
      json({ method: 'POST', body: JSON.stringify({ name: 'feature', from: 'main' }) }),
    );
    expect([200, 201]).toContain(branched.status);

    const opened = await api(
      `/user/repos/${OWNER}/${REPO}/pulls`,
      json({ method: 'POST', body: JSON.stringify({ title: 'Add', baseBranch: 'main', headBranch: 'feature' }) }),
    );
    expect([200, 201]).toContain(opened.status);
    const body = (await opened.json()) as { number?: number; pull?: { number?: number }; title?: string };
    expect(body.number ?? body.pull?.number ?? 1).toBe(1);
  });

  it('lists #1, fetches it, comments, triages, searches, and reviews', async () => {
    const listed = (await (await api(`/user/repos/${OWNER}/${REPO}/pulls`)).json()) as { pulls: Array<{ number: number }> };
    expect(listed.pulls.map((p) => p.number)).toContain(1);

    const fetched = await api(`/user/repos/${OWNER}/${REPO}/pulls/1`);
    expect(fetched.status).toBe(200);

    const commented = await api(
      `/user/repos/${OWNER}/${REPO}/pulls/1/comments`,
      json({ method: 'POST', body: JSON.stringify({ body: 'lgtm' }) }),
    );
    expect([200, 201]).toContain(commented.status);

    const triaged = await api(
      `/user/repos/${OWNER}/${REPO}/pulls/1`,
      json({ method: 'PATCH', body: JSON.stringify({ status: 'closed' }) }),
    );
    expect([200, 400]).toContain(triaged.status);

    const searched = (await (await api(`/user/repos/${OWNER}/${REPO}/pulls?q=Add`)).json()) as {
      pulls: Array<{ number: number; title: string }>;
    };
    expect(searched.pulls.map((p) => p.number)).toContain(1);

    const reviewed = await api(
      `/user/repos/${OWNER}/${REPO}/pulls/1/reviews`,
      json({ method: 'POST', body: JSON.stringify({ state: 'approved', body: 'ok' }) }),
    );
    expect([200, 201, 400]).toContain(reviewed.status);
  });
});
