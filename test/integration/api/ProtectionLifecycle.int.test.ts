import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureUser, seedRepo, setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'protect-demo';
const REVIEWER = 'reviewer@example.com';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(init?: RequestInit): RequestInit {
  return { ...init, headers: { 'Content-Type': 'application/json' } };
}

describe('branch protection lifecycle on real D1', () => {
  let repoId = '';

  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    await ensureUser(testEnv.DB, REVIEWER, 'reviewer');
    repoId = await seedRepo(testEnv.DB, { ownerEmail: USER, owner: OWNER, name: REPO });
  });

  const rulesPath = `/user/repos/${OWNER}/${REPO}/rules`;

  it('creates, lists, rejects duplicates, and deletes rules', async () => {
    const created = await api(
      rulesPath,
      json({ method: 'POST', body: JSON.stringify({ pattern: 'main', requirePr: true, requiredApprovals: 1 }) }),
    );
    expect(created.status).toBe(201);
    const rule = (await created.json()) as { rule: { id: string; pattern: string; requirePr: boolean; requiredApprovals: number } };
    expect(rule.rule.pattern).toBe('main');
    expect(rule.rule.requirePr).toBe(true);

    const listed = (await (await api(rulesPath)).json()) as { rules: Array<{ id: string }> };
    expect(listed.rules.map((r) => r.id)).toContain(rule.rule.id);

    expect((await api(rulesPath, json({ method: 'POST', body: JSON.stringify({ pattern: 'main' }) }))).status).toBe(400);
    expect((await api(rulesPath, json({ method: 'POST', body: JSON.stringify({ pattern: 'has space' }) }))).status).toBe(400);
    expect((await api(rulesPath, json({ method: 'POST', body: JSON.stringify({ pattern: 'other', requiredApprovals: 7 }) }))).status).toBe(
      400,
    );

    expect((await api(`${rulesPath}/${rule.rule.id}`, { method: 'DELETE' })).status).toBe(200);
    const after = (await (await api(rulesPath)).json()) as { rules: unknown[] };
    expect(after.rules).toHaveLength(0);
  });

  it('blocks merges until the approval quorum is met (self-approval excluded)', async () => {
    const testEnv = env as unknown as TestEnv;
    const now = Math.floor(Date.now() / 1000);
    await testEnv.DB.prepare(
      `INSERT INTO pull_requests (id, repository_id, full_name, number, title, body, status, base_branch, head_branch, base_oid, head_oid, merge_base_oid, creator_email, merged_by, merged_at, created_at, updated_at) VALUES (?, ?, ?, 1, 'Big change', NULL, 'open', 'main', 'feature', NULL, NULL, NULL, ?, NULL, NULL, ?, ?)`,
    )
      .bind('pr-protect-1', repoId, `${OWNER}/${REPO}`, USER.toLowerCase(), now, now)
      .run();
    await api(rulesPath, json({ method: 'POST', body: JSON.stringify({ pattern: 'main', requirePr: true, requiredApprovals: 1 }) }));

    const mergePath = `/user/repos/${OWNER}/${REPO}/pulls/1/merge`;
    const blocked = await api(mergePath, json({ method: 'POST', body: JSON.stringify({}) }));
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toContain('requires 1 approvals (0 so far)');

    // Self-approval by the PR creator must not count.
    await api(
      `/user/repos/${OWNER}/${REPO}/pulls/1/reviews`,
      json({ method: 'POST', body: JSON.stringify({ state: 'approved', body: 'lgtm' }) }),
    );
    const stillBlocked = await api(mergePath, json({ method: 'POST', body: JSON.stringify({}) }));
    expect(stillBlocked.status).toBe(409);

    // An outsider approval lifts the gate (merge then fails past the gate on
    // missing git branches — the seeded PR has no oids and the DO repo is empty).
    await testEnv.DB.prepare(
      `INSERT INTO pull_request_reviews (id, pull_request_id, author_email, state, body, commit_oid, created_at) VALUES (?, ?, ?, 'approved', NULL, NULL, ?)`,
    )
      .bind('rev-outsider-1', 'pr-protect-1', REVIEWER, now)
      .run();
    const pastGate = await api(mergePath, json({ method: 'POST', body: JSON.stringify({}) }));
    expect(pastGate.status).toBe(400);
    expect(((await pastGate.json()) as { error: string }).error).toContain('head branch not found');
  });

  it('blocks direct web writes and branch deletion on protected branches', async () => {
    const toB64 = (s: string): string => btoa(String.fromCodePoint(...new TextEncoder().encode(s)));
    const write = await api(
      `/user/repos/${OWNER}/${REPO}/contents`,
      json({ method: 'POST', body: JSON.stringify({ branch: 'main', path: 'x.txt', contentBase64: toB64('x') }) }),
    );
    expect(write.status).toBe(403);
    expect(((await write.json()) as { error: string }).error).toContain('open a pull request');

    const del = await api(`/user/repos/${OWNER}/${REPO}/branches?branch=main`, { method: 'DELETE' });
    expect(del.status).toBe(403);
    expect(((await del.json()) as { error: string }).error).toContain('protected against deletion');
  });
});
