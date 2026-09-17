import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedRepo, setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const OWNER = 'test';
const REPO = 'surfaces-demo';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(method: string, path: string, body?: unknown): Promise<Response> {
  return api(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('collab surfaces lifecycle on real D1', () => {
  beforeAll(async () => {
    const testEnv = env as unknown as TestEnv;
    await setupIntegrationTest(testEnv, USER);
    await seedRepo(testEnv.DB, { ownerEmail: USER, owner: OWNER, name: REPO });
  });

  it('runs the project board lifecycle', async () => {
    const created = await json('POST', `/user/repos/${OWNER}/${REPO}/projects`, { title: 'Roadmap' });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { project: { number: number; title: string } };
    expect(createdBody.project.number).toBe(1);

    const board = await api(`/user/repos/${OWNER}/${REPO}/projects/1`);
    expect(board.status).toBe(200);
    const boardBody = (await board.json()) as { columns: Array<{ id: string; title: string }>; cards: unknown[] };
    expect(boardBody.columns.map((c) => c.title)).toEqual(['Todo', 'In Progress', 'Done']);

    const firstColumn = boardBody.columns[0];
    const card = await json('POST', `/user/repos/${OWNER}/${REPO}/projects/1/cards`, { columnId: firstColumn.id, kind: 'note', noteTitle: 'Ship It' });
    expect(card.status).toBe(201);

    const secondColumn = boardBody.columns[1];
    const cardBody = (await card.json()) as { card: { id: string } };
    const moved = await json('PATCH', `/user/repos/${OWNER}/${REPO}/projects/1/cards/${cardBody.card.id}/move`, { toColumnId: secondColumn.id });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toMatchObject({ card: { columnId: secondColumn.id } });

    const dup = await json('POST', `/user/repos/${OWNER}/${REPO}/projects/1/columns`, { title: 'todo' });
    expect(dup.status).toBe(400);

    const pub = await api(`/repos/${OWNER}/${REPO}/projects`);
    expect(pub.status).toBe(200);
    const pubBody = (await pub.json()) as { projects: unknown[] };
    expect(pubBody.projects).toHaveLength(1);
  });

  it('runs the discussion lifecycle', async () => {
    const cats = await api(`/user/repos/${OWNER}/${REPO}/discussions/categories`);
    expect(cats.status).toBe(200);
    const catsBody = (await cats.json()) as { categories: Array<{ slug: string }> };
    expect(catsBody.categories.map((c) => c.slug).sort()).toEqual(['announcements', 'general', 'ideas', 'qa']);

    const created = await json('POST', `/user/repos/${OWNER}/${REPO}/discussions`, { title: 'Hello World', body: 'First post', categorySlug: 'general' });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ discussion: { number: 1 } });

    const comment = await json('POST', `/user/repos/${OWNER}/${REPO}/discussions/1/comments`, { body: 'Welcome!' });
    expect(comment.status).toBe(201);

    const answered = await json('PATCH', `/user/repos/${OWNER}/${REPO}/discussions/1`, { status: 'answered' });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ discussion: { status: 'answered' } });

    const locked = await json('PATCH', `/user/repos/${OWNER}/${REPO}/discussions/1`, { status: 'locked' });
    expect(locked.status).toBe(200);

    const blocked = await json('POST', `/user/repos/${OWNER}/${REPO}/discussions/1/comments`, { body: 'Too late' });
    expect(blocked.status).toBe(400);

    const detail = await api(`/repos/${OWNER}/${REPO}/discussions/1`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { comments: Array<{ body: string }> };
    expect(detailBody.comments.map((c) => c.body)).toContain('Welcome!');
  });

  it('runs the wiki lifecycle with revision conflicts', async () => {
    const created = await json('POST', `/user/repos/${OWNER}/${REPO}/wiki`, { slug: 'home', title: 'Home', body: 'v1' });
    expect(created.status).toBe(201);

    const page = await api(`/repos/${OWNER}/${REPO}/wiki/home`);
    expect(page.status).toBe(200);
    const pageBody = (await page.json()) as { page: { revision: number } };
    expect(pageBody.page.revision).toBe(1);

    const updated = await api(`/user/repos/${OWNER}/${REPO}/wiki/home`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'v2', expectedRevision: 1 }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ page: { revision: 2 } });

    const stale = await api(`/user/repos/${OWNER}/${REPO}/wiki/home`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'stale', expectedRevision: 1 }),
    });
    expect(stale.status).toBe(409);

    const history = await api(`/user/repos/${OWNER}/${REPO}/wiki/home/revisions`);
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as { revisions: unknown[] };
    expect(historyBody.revisions).toHaveLength(2);
  });

  it('runs the snippet lifecycle with secret visibility', async () => {
    const created = await json('POST', '/user/snippets', { title: 'Hello', visibility: 'public', files: [{ filename: 'hello.txt', body: 'hi' }] });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { snippet: { id: string; visibility: string } };
    expect(createdBody.snippet.visibility).toBe('public');

    const fetched = await api(`/snippets/${createdBody.snippet.id}`);
    expect(fetched.status).toBe(200);

    const madeSecret = await json('PATCH', `/user/snippets/${createdBody.snippet.id}`, { visibility: 'secret' });
    expect(madeSecret.status).toBe(200);

    const mine = await api('/user/snippets');
    expect(mine.status).toBe(200);
    const mineBody = (await mine.json()) as { snippets: unknown[] };
    expect(mineBody.snippets).toHaveLength(1);

    const searched = await api('/search?q=Hello&type=snippets');
    expect(searched.status).toBe(200);

    const deleted = await api(`/user/snippets/${createdBody.snippet.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await api(`/snippets/${createdBody.snippet.id}`)).status).toBe(404);
  });

  it('searches discussions with visibility filtering', async () => {
    const res = await api('/search?q=Hello&type=discussions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { discussions: Array<{ title: string }> };
    expect(body.discussions.map((d) => d.title)).toContain('Hello World');
  });
});
