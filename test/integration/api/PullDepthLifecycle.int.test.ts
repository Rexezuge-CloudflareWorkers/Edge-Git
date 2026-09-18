import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedRepo, setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'depth-demo';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(init?: RequestInit & { body?: unknown }): RequestInit {
  return { ...init, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify((init?.body ?? {}) as Record<string, unknown>) };
}

async function seedPull(db: D1Database, repoId: string, number: number, title: string, body: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO pull_requests (id, repository_id, full_name, number, title, body, status, base_branch, head_branch, base_oid, head_oid, merge_base_oid, creator_email, created_at, updated_at) ` +
        `VALUES (?, ?, ?, ?, ?, ?, 'open', 'main', 'feature', NULL, NULL, NULL, ?, ?, ?)`,
    )
    .bind(id, repoId, `${OWNER}/${REPO}`, number, title, body, USER, now, now)
    .run();
  return id;
}

describe('PR depth part 2 on real D1', () => {
  let repoId = '';

  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    repoId = await seedRepo(testEnv.DB, { ownerEmail: USER, owner: OWNER, name: REPO });
    await seedPull(testEnv.DB, repoId, 1, 'Add threaded reviews', 'inline comments please');
  });

  it('opens, lists, replies, and resolves threads (owner + public)', async () => {
    const open = await api(
      `/user/repos/${OWNER}/${REPO}/pulls/1/threads`,
      json({ method: 'POST', body: { path: 'src/app.ts', line: 42, side: 'new', body: 'nit?' } }),
    );
    expect(open.status).toBe(201);
    const opened = (await open.json()) as { thread: { id: string; status: string; comments: Array<{ body: string }> } };
    expect(opened.thread.status).toBe('open');
    expect(opened.thread.comments.map((c) => c.body)).toEqual(['nit?']);
    const threadId = opened.thread.id;

    const invalid = await api(`/user/repos/${OWNER}/${REPO}/pulls/1/threads`, json({ method: 'POST', body: { path: '', body: 'x' } }));
    expect(invalid.status).toBe(400);

    const owned = await api(`/user/repos/${OWNER}/${REPO}/pulls/1/threads`);
    expect(owned.status).toBe(200);
    expect(((await owned.json()) as { threads: unknown[] }).threads).toHaveLength(1);

    const pub = await api(`/repos/${OWNER}/${REPO}/pulls/1/threads`);
    expect(pub.status).toBe(200);
    expect(((await pub.json()) as { threads: unknown[] }).threads).toHaveLength(1);

    const reply = await api(
      `/user/repos/${OWNER}/${REPO}/pulls/1/threads/${threadId}/replies`,
      json({ method: 'POST', body: { body: 'ack' } }),
    );
    expect(reply.status).toBe(201);

    const resolve = await api(
      `/user/repos/${OWNER}/${REPO}/pulls/1/threads/${threadId}`,
      json({ method: 'PATCH', body: { resolved: true } }),
    );
    expect(resolve.status).toBe(200);
    expect(await resolve.json()).toMatchObject({ thread: { status: 'resolved' } });

    const badToggle = await api(
      `/user/repos/${OWNER}/${REPO}/pulls/1/threads/${threadId}`,
      json({ method: 'PATCH', body: { resolved: 'yes' } }),
    );
    expect(badToggle.status).toBe(400);

    const missing = await api(`/user/repos/${OWNER}/${REPO}/pulls/1/threads/nope/replies`, json({ method: 'POST', body: { body: 'x' } }));
    expect(missing.status).toBe(404);
  });

  it('dismisses reviews and clears the merge gate', async () => {
    const testEnv = env as unknown as TestEnv;
    const now = Math.floor(Date.now() / 1000);
    const pr = await testEnv.DB.prepare('SELECT id FROM pull_requests WHERE repository_id = ? AND number = 1')
      .bind(repoId)
      .first<{ id: string }>();
    await testEnv.DB.prepare(
      `INSERT INTO pull_request_reviews (id, pull_request_id, author_email, state, body, commit_oid, created_at) VALUES (?, ?, ?, 'changes_requested', 'fix this', NULL, ?)`,
    )
      .bind(crypto.randomUUID(), pr?.id ?? '', 'reviewer@example.com', now)
      .run();

    const reviews = (await (await api(`/user/repos/${OWNER}/${REPO}/pulls/1/reviews`)).json()) as {
      reviews: Array<{ id: string; state: string }>;
    };
    const target = reviews.reviews.find((r) => r.state === 'changes_requested');
    expect(target).toBeDefined();

    const dismiss = await api(
      `/user/repos/${OWNER}/${REPO}/pulls/1/reviews/${target?.id}/dismiss`,
      json({ method: 'POST', body: { reason: 'outdated' } }),
    );
    expect(dismiss.status).toBe(200);
    expect(await dismiss.json()).toMatchObject({ review: { dismissed: 1 } });

    const again = await api(`/user/repos/${OWNER}/${REPO}/pulls/1/reviews/${target?.id}/dismiss`, json({ method: 'POST', body: {} }));
    expect(again.status).toBe(400);

    const after = (await (await api(`/user/repos/${OWNER}/${REPO}/pulls/1/reviews`)).json()) as {
      reviews: Array<{ id: string; dismissed?: number }>;
    };
    expect(after.reviews.find((r) => r.id === target?.id)?.dismissed).toBe(1);
  });

  it('searches pull requests globally and per repo', async () => {
    const global = await api(`/search?q=threaded&type=pulls`);
    expect(global.status).toBe(200);
    const globalBody = (await global.json()) as { pulls: Array<{ number: number }> };
    expect(globalBody.pulls.map((p) => p.number)).toContain(1);

    const scoped = await api(`/user/repos/${OWNER}/${REPO}/pulls?q=threaded`);
    expect(scoped.status).toBe(200);
    const scopedBody = (await scoped.json()) as { pulls: Array<{ number: number }> };
    expect(scopedBody.pulls.map((p) => p.number)).toContain(1);

    const pubScoped = await api(`/repos/${OWNER}/${REPO}/pulls?q=threaded`);
    expect(pubScoped.status).toBe(200);

    const scopedSearch = await api(`/search?q=threaded&type=pulls&owner=${OWNER}&repo=${REPO}`);
    expect(scopedSearch.status).toBe(200);
  });

  it('returns empty codeowners without a CODEOWNERS file', async () => {
    const res = await api(`/user/repos/${OWNER}/${REPO}/pulls/1/codeowners`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ owners: [], rules: 0 });
  });
});
