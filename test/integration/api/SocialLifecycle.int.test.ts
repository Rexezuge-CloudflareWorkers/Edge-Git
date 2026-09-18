import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { setupIntegrationTest } from '../helpers/setup';

const USER = 'test@example.com';
const FRIEND = 'friend@example.com';
const OWNER = 'test';
const REPO = 'social-demo';

type TestEnv = Record<string, unknown> & { DB: D1Database };

function api(path: string, init?: RequestInit): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, init);
}

function json(init?: RequestInit): RequestInit {
  return { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } };
}

async function body<T>(res: Response): Promise<T> {
  expect(res.status).toBeLessThan(400);
  return (await res.json()) as T;
}

describe('social lifecycle on real D1', () => {
  beforeAll(async () => {
    await setupIntegrationTest(env as unknown as TestEnv, USER);
  });

  it('creates a repo and auto-watches it for the creator', async () => {
    const res = await api('/user/repos', json({ method: 'POST', body: JSON.stringify({ name: REPO, description: 'Social Repo' }) }));
    expect(res.status).toBe(201);
    const watches = await body<{ repos: Array<{ name: string }> }>(await api('/user/watches'));
    expect(watches.repos.map((r) => r.name)).toContain(REPO);
    const activity = await body<{ events: Array<{ type: string }> }>(await api(`/repos/${OWNER}/${REPO}/activity`));
    expect(activity.events.map((e) => e.type)).toContain('repo_created');
  });

  it('stars and unstars idempotently with public counts', async () => {
    const before = await body<{ count: number; viewerStarred: boolean }>(await api(`/repos/${OWNER}/${REPO}/stars`));
    expect(before.count).toBe(0);
    const starred = await body<{ starred: boolean; starsCount: number }>(await api(`/user/repos/${OWNER}/${REPO}/star`, { method: 'PUT' }));
    expect(starred).toMatchObject({ starred: true, starsCount: 1 });
    // Second star is a no-op (INSERT OR IGNORE).
    await api(`/user/repos/${OWNER}/${REPO}/star`, { method: 'PUT' });
    const pub = await body<{ count: number; viewerStarred: boolean }>(await api(`/repos/${OWNER}/${REPO}/stars`));
    expect(pub.count).toBe(1);
    const mine = await body<{ repos: Array<{ name: string }> }>(await api('/user/stars'));
    expect(mine.repos.map((r) => r.name)).toContain(REPO);
    const unstarred = await body<{ starred: boolean; starsCount: number }>(
      await api(`/user/repos/${OWNER}/${REPO}/star`, { method: 'DELETE' }),
    );
    expect(unstarred).toMatchObject({ starred: false, starsCount: 0 });
  });

  it('toggles watches and hides private repos from strangers', async () => {
    const watched = await body<{ watching: boolean }>(await api(`/user/repos/${OWNER}/${REPO}/watch`, { method: 'PUT' }));
    expect(watched.watching).toBe(true);
    const pub = await body<{ count: number }>(await api(`/repos/${OWNER}/${REPO}/watches`));
    expect(pub.count).toBeGreaterThanOrEqual(1);
    expect((await api(`/user/repos/${OWNER}/nope/watch`, { method: 'PUT' })).status).toBe(404);
  });

  it('fans out issue notifications to watchers but not the actor', async () => {
    const db = (env as unknown as TestEnv).DB;
    const repo = (await db
      .prepare('SELECT id FROM repositories WHERE owner = ? AND name = ?')
      .bind(OWNER, REPO)
      .first<{ id: string }>()) as { id: string };
    const now = Math.floor(Date.now() / 1000);
    await db.prepare('INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)').bind(FRIEND, now).run();
    await db
      .prepare('INSERT OR IGNORE INTO repo_watches (repo_id, user_email, created_at) VALUES (?, ?, ?)')
      .bind(repo.id, FRIEND, now)
      .run();
    const created = await body<{ number: number }>(
      await api(
        `/user/repos/${OWNER}/${REPO}/issues`,
        json({ method: 'POST', body: JSON.stringify({ title: 'Hello @nobody-here', body: 'cc' }) }),
      ),
    );
    const activity = await body<{ events: Array<{ type: string; subject_number: number | null }> }>(
      await api(`/repos/${OWNER}/${REPO}/activity`),
    );
    const opened = activity.events.find((e) => e.type === 'issue_opened');
    expect(opened?.subject_number).toBe(created.number);
    // Actor (test user) is excluded from their own fan-out.
    const inbox = await body<{ unreadCount: number }>(await api('/user/notifications'));
    expect(inbox.unreadCount).toBe(0);
    // The D1-backed watcher got exactly one unread notification.
    const rows = (await db.prepare('SELECT * FROM notifications WHERE user_email = ?').bind(FRIEND).all()).results as Array<{
      is_read: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].is_read).toBe(0);
  });

  it('reads and clears the inbox via the API', async () => {
    const db = (env as unknown as TestEnv).DB;
    const now = Math.floor(Date.now() / 1000);
    const id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT OR IGNORE INTO notifications (id, user_email, repository_id, full_name, actor_email, type, title, is_read, created_at) VALUES (?, ?, NULL, ?, ?, 'issue_opened', 'Seeded', 0, ?)",
      )
      .bind(id, USER, `${OWNER}/${REPO}`, FRIEND, now)
      .run();
    const list = await body<{ notifications: Array<{ id: string }>; unreadCount: number }>(await api('/user/notifications?unreadOnly=1'));
    expect(list.unreadCount).toBe(1);
    expect(list.notifications.map((n) => n.id)).toContain(id);
    expect((await api(`/user/notifications/${id}/read`, { method: 'PATCH' })).status).toBe(200);
    expect((await api(`/user/notifications/${id}/read`, { method: 'PATCH' })).status).toBe(200);
    expect((await api('/user/notifications/nope/read', { method: 'PATCH' })).status).toBe(404);
    const cleared = await body<{ marked: number }>(await api('/user/notifications/read-all', { method: 'POST' }));
    expect(cleared.marked).toBe(0);
    const count = await body<{ unreadCount: number }>(await api('/user/notifications/unread-count'));
    expect(count.unreadCount).toBe(0);
  });
});
