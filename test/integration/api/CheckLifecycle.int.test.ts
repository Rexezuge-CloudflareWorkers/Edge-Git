import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCustomCheckScript } from '@edge-git/background/checks/CustomJsSandbox';
import { seedRepo, setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'checks-demo';
const SHA = 'c'.repeat(40);

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(init?: RequestInit): RequestInit {
  return { ...init, headers: { 'Content-Type': 'application/json' } };
}

describe('checks lifecycle on real D1', () => {
  let repoId = '';

  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    repoId = await seedRepo(testEnv.DB, { ownerEmail: USER, owner: OWNER, name: REPO });
  });

  const checksBase = `/user/repos/${OWNER}/${REPO}/checks`;
  const publicChecks = `/repos/${OWNER}/${REPO}/commits/${SHA}/checks`;

  it('reports, lists, and completes check runs', async () => {
    const reported = await api(checksBase, json({ method: 'POST', body: JSON.stringify({ headSha: SHA, context: 'lint' }) }));
    expect(reported.status).toBe(201);
    const created = (await reported.json()) as { check: { id: string; status: string; conclusion: null } };
    expect(created.check.status).toBe('queued');

    const listed = (await (await api(publicChecks)).json()) as { state: string; checks: Array<{ context: string }> };
    expect(listed.state).toBe('pending');
    expect(listed.checks.map((c) => c.context)).toContain('lint');

    const completed = await api(
      `${checksBase}/${created.check.id}`,
      json({ method: 'PATCH', body: JSON.stringify({ status: 'completed', conclusion: 'success', outputTitle: 'Lint Ok' }) }),
    );
    expect(completed.status).toBe(200);
    const done = (await completed.json()) as { check: { status: string; conclusion: string } };
    expect(done.check).toMatchObject({ status: 'completed', conclusion: 'success' });

    const green = (await (await api(publicChecks)).json()) as { state: string };
    expect(green.state).toBe('success');
  });

  it('rejects invalid check payloads', async () => {
    expect((await api(checksBase, json({ method: 'POST', body: JSON.stringify({ headSha: 'short', context: 'lint' }) }))).status).toBe(400);
    expect((await api(checksBase, json({ method: 'POST', body: JSON.stringify({ headSha: SHA, context: '' }) }))).status).toBe(400);
  });

  it('blocks merges on pending required checks and passes once green', async () => {
    const testEnv = env as unknown as TestEnv;
    const now = Math.floor(Date.now() / 1000);
    // Fresh SHA: no runs exist yet, so the gate must report pending.
    const headSha = 'd'.repeat(40);
    await testEnv.DB.prepare(
      `INSERT INTO pull_requests (id, repository_id, full_name, number, title, body, status, base_branch, head_branch, base_oid, head_oid, merge_base_oid, creator_email, merged_by, merged_at, created_at, updated_at) VALUES (?, ?, ?, 7, 'Checked change', NULL, 'open', 'main', 'feature', NULL, ?, NULL, ?, NULL, NULL, ?, ?)`,
    )
      .bind('pr-checks-7', repoId, `${OWNER}/${REPO}`, headSha, USER.toLowerCase(), now, now)
      .run();
    await api(
      `/user/repos/${OWNER}/${REPO}/rules`,
      json({ method: 'POST', body: JSON.stringify({ pattern: 'main', requireStatusChecks: ['lint'] }) }),
    );

    const mergePath = `/user/repos/${OWNER}/${REPO}/pulls/7/merge`;
    const blocked = await api(mergePath, json({ method: 'POST', body: JSON.stringify({}) }));
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: string }).error).toContain('required status checks');

    await api(checksBase, json({ method: 'POST', body: JSON.stringify({ headSha, context: 'lint' }) }));
    const runs = (await (await api(`/repos/${OWNER}/${REPO}/commits/${headSha}/checks`)).json()) as { checks: Array<{ id: string }> };
    const runId = runs.checks.find(() => true)?.id ?? '';
    await api(`${checksBase}/${runId}`, json({ method: 'PATCH', body: JSON.stringify({ status: 'completed', conclusion: 'success' }) }));

    // Gate now passes; merge fails past the gate on missing git branches (the
    // seeded PR points at refs that do not exist in the empty DO repo).
    const pastGate = await api(mergePath, json({ method: 'POST', body: JSON.stringify({}) }));
    expect(pastGate.status).not.toBe(409);
  });

  it('executes repo-defined scripts in the QuickJS sandbox inside workerd', async () => {
    const result = await runCustomCheckScript({
      script:
        'function main(ctx) { const names = ctx.listFiles(); return { conclusion: "success", title: "Workerd Ok", summary: "files=" + names.length + " readme=" + ctx.readFile("README.md") }; }',
      files: { 'README.md': '# Hi' },
      env: {},
      allowHosts: [],
      limits: { cpuMs: 3000, memoryMb: 16, maxFetches: 0, fetchTimeoutMs: 1000, maxResponseBytes: 1024, wallMs: 15000, maxLogBytes: 1024 },
    });
    expect(result.conclusion).toBe('success');
    expect(result.summary).toContain('files=1');
  });
});
