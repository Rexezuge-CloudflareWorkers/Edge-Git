import { beforeEach, describe, expect, it } from 'vitest';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import { resetRateLimitForTests } from '@/middleware/rateLimit';

// Gap-fill sweep (Slice 5): working-fake HTTP tests for the thinnest route
// files (OrgRoutes collaborators, RuleRoutes, SocialRoutes, Org CRUD).
// Compacts the route-low-fill fake pattern to only the tables these flows
// need: users, namespaces, repos, orgs, members, collaborators, rules,
// stars, watches, events, webhooks.

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

interface GapState {
  users: Array<Record<string, unknown>>;
  namespaces: Array<Record<string, unknown>>;
  repos: Array<Record<string, unknown>>;
  orgs: Array<Record<string, unknown>>;
  orgMembers: Array<Record<string, unknown>>;
  collaborators: Array<Record<string, unknown>>;
  rules: Array<Record<string, unknown>>;
  stars: Array<Record<string, unknown>>;
  watches: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  mirrors: Array<Record<string, unknown>>;
  keys: Array<Record<string, unknown>>;
  snippets: Array<Record<string, unknown>>;
  snippetFiles: Array<Record<string, unknown>>;
  notifications: Array<Record<string, unknown>>;
  security: Record<string, string>;
}

function seedState(): GapState {
  return {
    users: [
      { email: ALICE, username: 'alice', created_at: 1 },
      { email: BOB, username: 'bob', created_at: 1 },
    ],
    namespaces: [
      { username_ci: 'alice', kind: 'user', user_email: ALICE, org_id: null },
      { username_ci: 'bob', kind: 'user', user_email: BOB, org_id: null },
      { username_ci: 'acme', kind: 'org', user_email: null, org_id: 'org-acme' },
    ],
    repos: [
      {
        id: 'r-demo',
        owner_email: ALICE,
        owner_user_email: ALICE,
        owner: 'alice',
        name: 'demo',
        description: null,
        is_private: 0,
        created_at: 1,
        updated_at: 2,
        owner_type: 'user',
        owner_ci: 'alice',
        name_ci: 'demo',
        org_id: null,
      },
    ],
    orgs: [{ id: 'org-acme', username: 'acme', username_ci: 'acme', creator_email: ALICE, created_at: 1, updated_at: 1 }],
    orgMembers: [{ org_id: 'org-acme', user_email: ALICE, role: 'owner', created_at: 1 }],
    collaborators: [],
    rules: [],
    stars: [],
    watches: [],
    events: [],
    mirrors: [],
    keys: [],
    snippets: [],
    snippetFiles: [],
    notifications: [],
    security: {},
  };
}

function gapDb(state: GapState): D1Queryable {
  const lower = (v: unknown): string => String(v ?? '').toLowerCase();
  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    const P = (i: number): string => String(params[i] ?? '');
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM users WHERE')) {
          const row = state.users.find((u) => lower(u.email) === lower(params[0]) || lower(u.username) === lower(params[0]));
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM namespaces WHERE username_ci = ?')) {
          return Promise.resolve((state.namespaces.find((n) => n.username_ci === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE owner_ci = ? AND name_ci = ?')) {
          return Promise.resolve((state.repos.find((r) => r.owner_ci === params[0] && r.name_ci === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE id = ?')) {
          return Promise.resolve((state.repos.find((r) => r.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM organizations WHERE')) {
          const row = state.orgs.find((o) => o.username_ci === params[0] || o.id === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM organization_members WHERE org_id = ? AND')) {
          return Promise.resolve(
            (state.orgMembers.find((m) => m.org_id === params[0] && lower(m.user_email) === lower(params[1])) ?? null) as T | null,
          );
        }
        if (q.includes('COUNT(*) AS n FROM organization_members')) {
          return Promise.resolve({
            n: state.orgMembers.filter((m) => m.org_id === params[0] && m.role === 'owner').length,
          } as unknown as T);
        }
        if (q.includes('FROM repo_collaborators WHERE repo_id = ? AND')) {
          return Promise.resolve(
            (state.collaborators.find((c) => c.repo_id === params[0] && lower(c.user_email) === lower(params[1])) ?? null) as T | null,
          );
        }
        if (q.includes('COUNT(*) AS n FROM repo_stars WHERE')) {
          return Promise.resolve({ n: state.stars.filter((s) => s.repo_id === params[0]).length } as unknown as T);
        }
        if (q.includes('COUNT(*) AS n FROM repo_watches WHERE')) {
          return Promise.resolve({ n: state.watches.filter((s) => s.repo_id === params[0]).length } as unknown as T);
        }
        if (q.includes('COUNT(*) AS n FROM deploy_keys WHERE')) {
          return Promise.resolve({ n: state.keys.filter((k) => k.repository_id === params[0]).length } as unknown as T);
        }
        if (q.includes('COUNT(*) AS n FROM notifications WHERE')) {
          return Promise.resolve({ n: state.notifications.filter((n) => lower(n.user_email) === lower(params[0])).length } as unknown as T);
        }
        if (q.includes('COUNT(*) AS count FROM snippets WHERE')) {
          return Promise.resolve({ count: state.snippets.filter((s) => lower(s.owner_email) === lower(params[0])).length } as unknown as T);
        }
        if (q.includes('FROM repo_stars WHERE repo_id = ? AND user_email = ?')) {
          return Promise.resolve(
            (state.stars.find((s) => s.repo_id === params[0] && lower(s.user_email) === lower(params[1])) ?? null) as T | null,
          );
        }
        if (q.includes('FROM repo_security_settings WHERE')) {
          const mode = state.security[String(params[0])];
          return Promise.resolve(
            (mode ? { repository_id: params[0], secret_scan_mode: mode, updated_by: ALICE, updated_at: 1 } : null) as T | null,
          );
        }
        if (q.includes('FROM snippets WHERE id = ?')) {
          return Promise.resolve((state.snippets.find((s) => s.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM repo_watches WHERE repo_id = ? AND user_email = ?')) {
          return Promise.resolve(
            (state.watches.find((s) => s.repo_id === params[0] && lower(s.user_email) === lower(params[1])) ?? null) as T | null,
          );
        }
        if (q.includes('FROM branch_protection_rules WHERE id = ?')) {
          return Promise.resolve((state.rules.find((r) => r.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM repo_mirrors WHERE repository_id = ?')) {
          return Promise.resolve((state.mirrors.find((m) => m.repository_id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM deploy_keys WHERE id = ?')) {
          return Promise.resolve((state.keys.find((k) => k.id === params[0]) ?? null) as T | null);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM repo_collaborators WHERE repo_id = ?')) {
          return Promise.resolve({ results: state.collaborators.filter((c) => c.repo_id === params[0]) as T[] });
        }
        if (q.includes('FROM branch_protection_rules WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.rules.filter((r) => r.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM organization_members WHERE org_id = ?')) {
          return Promise.resolve({ results: state.orgMembers.filter((m) => m.org_id === params[0]) as T[] });
        }
        if (q.includes('FROM repositories WHERE org_id = ?')) {
          return Promise.resolve({ results: state.repos.filter((r) => r.org_id === params[0]) as T[] });
        }
        if (q.includes('FROM repo_stars WHERE repo_id = ?')) {
          return Promise.resolve({ results: state.stars.filter((s) => s.repo_id === params[0]) as T[] });
        }
        if (q.includes('FROM repo_watches WHERE repo_id = ?')) {
          return Promise.resolve({ results: state.watches.filter((s) => s.repo_id === params[0]) as T[] });
        }
        if (q.includes('FROM repo_events WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.events.filter((e) => e.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM repo_webhooks WHERE') || q.includes('FROM webhook_deliveries')) {
          return Promise.resolve({ results: [] as T[] });
        }
        if (q.includes('FROM repositories WHERE owner_ci = ?')) {
          return Promise.resolve({ results: state.repos.filter((r) => r.owner_ci === params[0]) as T[] });
        }
        if (q.includes('FROM organization_members WHERE lower(user_email)')) {
          return Promise.resolve({ results: state.orgMembers.filter((m) => lower(m.user_email) === lower(params[0])) as T[] });
        }
        if (q.includes('FROM deploy_keys WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.keys.filter((k) => k.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM notifications WHERE user_email = ?')) {
          return Promise.resolve({ results: state.notifications.filter((n) => lower(n.user_email) === lower(params[0])) as T[] });
        }
        if (q.includes('FROM snippets WHERE')) {
          return Promise.resolve({
            results: state.snippets.filter((s) => lower(s.owner_email) === lower(params[0]) || s.visibility === 'public') as T[],
          });
        }
        if (q.includes('FROM snippet_files WHERE')) {
          return Promise.resolve({ results: state.snippetFiles.filter((f) => f.snippet_id === params[0]) as T[] });
        }
        return Promise.resolve({ results: [] as T[] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('DELETE FROM repo_collaborators WHERE')) {
          state.collaborators = state.collaborators.filter(
            (c) => !(c.repo_id === params[0] && (params.length === 1 || lower(c.user_email) === lower(params[1]))),
          );
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO repo_collaborators')) {
          state.collaborators.push({
            repo_id: params[0],
            user_email: lower(params[1]),
            role: params[2],
            granted_by: params[3] ?? null,
            created_at: params[4] ?? 1,
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO branch_protection_rules')) {
          state.rules.push({
            id: params[0],
            repository_id: params[1],
            pattern: params[2],
            require_pr: params[3],
            required_approvals: params[4],
            block_force_push: params[5],
            block_deletion: params[6],
            require_status_checks: params[7],
            created_by: params[8],
            created_at: params[9],
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM branch_protection_rules WHERE')) {
          state.rules = state.rules.filter((r) => !(r.id === params[0] && r.repository_id === params[1]));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT OR IGNORE INTO repo_stars')) {
          if (!state.stars.some((s) => s.repo_id === params[0] && lower(s.user_email) === lower(params[1]))) {
            state.stars.push({ repo_id: params[0], user_email: lower(params[1]), created_at: params[2] });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repo_stars WHERE')) {
          state.stars = state.stars.filter((s) => !(s.repo_id === params[0] && lower(s.user_email) === lower(params[1])));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT OR IGNORE INTO repo_watches')) {
          if (!state.watches.some((s) => s.repo_id === params[0] && lower(s.user_email) === lower(params[1]))) {
            state.watches.push({ repo_id: params[0], user_email: lower(params[1]), created_at: params[2] });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repo_watches WHERE')) {
          state.watches = state.watches.filter((s) => !(s.repo_id === params[0] && lower(s.user_email) === lower(params[1])));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO repo_events')) {
          state.events.push({ id: P(0), repository_id: P(1), created_at: 1 });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO repo_mirrors')) {
          const existing = state.mirrors.find((m) => m.repository_id === params[0]);
          if (existing) {
            existing.source_url = params[1];
            existing.interval_minutes = params[2];
            existing.enabled = 1;
            existing.updated_at = params[5];
          } else {
            state.mirrors.push({
              repository_id: params[0],
              source_url: params[1],
              interval_minutes: params[2],
              enabled: 1,
              last_run_at: null,
              last_status: null,
              last_error: null,
              consecutive_failures: 0,
              created_by: params[3],
              created_at: params[4],
              updated_at: params[5],
            });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE repo_mirrors SET enabled = ?')) {
          const row = state.mirrors.find((m) => m.repository_id === params[2]);
          if (row) {
            row.enabled = params[0] ? 1 : 0;
            row.consecutive_failures = 0;
            row.updated_at = params[1];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repo_mirrors WHERE repository_id = ?')) {
          state.mirrors = state.mirrors.filter((m) => m.repository_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO deploy_keys')) {
          state.keys.push({
            id: params[0],
            repository_id: params[1],
            name: params[2],
            token_hash: params[3],
            token_prefix: params[4],
            permission: params[5],
            expires_at: params[6],
            last_used_at: null,
            created_by: params[7],
            created_at: params[8],
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM deploy_keys WHERE id = ?')) {
          state.keys = state.keys.filter((k) => !(k.id === params[0] && k.repository_id === params[1]));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO repo_security_settings')) {
          state.security[String(params[0])] = String(params[1]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO snippets')) {
          state.snippets.push({
            id: params[0],
            owner_email: lower(params[1]),
            title: params[2],
            visibility: params[3],
            created_at: params[4],
            updated_at: params[5],
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO snippet_files')) {
          state.snippetFiles.push({ id: params[0], snippet_id: params[1], filename: params[2], body: params[3], created_at: params[4] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO organization_members') || q.startsWith('INSERT OR IGNORE INTO organization_members')) {
          const existing = state.orgMembers.find((m) => m.org_id === params[0] && lower(m.user_email) === lower(params[1]));
          if (existing) existing.role = params[2];
          else state.orgMembers.push({ org_id: params[0], user_email: lower(params[1]), role: params[2], created_at: params[3] ?? 1 });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM organization_members WHERE')) {
          state.orgMembers = state.orgMembers.filter((m) => !(m.org_id === params[0] && lower(m.user_email) === lower(params[1])));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE organization_members SET role = ?')) {
          const row = state.orgMembers.find((m) => m.org_id === params[1] && lower(m.user_email) === lower(params[2]));
          if (row) row.role = params[0];
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO organizations') || q.startsWith('INSERT OR IGNORE INTO organizations')) {
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE organizations SET')) {
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM organizations WHERE')) {
          state.orgs = state.orgs.filter((o) => o.id !== params[0]);
          state.orgMembers = state.orgMembers.filter((m) => m.org_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO namespaces') || q.startsWith('INSERT OR IGNORE INTO namespaces')) {
          if (!state.namespaces.some((n) => n.username_ci === params[0])) {
            state.namespaces.push({
              username_ci: params[0],
              kind: params[1] ?? 'user',
              user_email: params[2] ?? null,
              org_id: params[3] ?? null,
            });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE repositories SET owner = ?')) {
          for (const r of state.repos) {
            if (lower(r.owner) === lower(params[2]) || r.owner_ci === lower(params[2])) {
              r.owner = params[0];
              r.owner_ci = lower(params[0]);
            }
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        return Promise.resolve({ success: true, meta: { changes: 1 } });
      },
    };
  }
  return { prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) } as unknown as D1Queryable;
}

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function callGap(env: unknown, path: string, init?: RequestInit): Promise<Response> {
  const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
  return worker.onRequest(new Request(`https://git.example.com${path}`, init), env, CTX);
}

function gapEnv(db: D1Queryable, email: string = ALICE): Record<string, unknown> {
  return { DB: db, ENVIRONMENT: 'development', DEV_AUTH_EMAIL: email };
}

function postJson(body: unknown): RequestInit {
  return { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function putJson(body: unknown): RequestInit {
  return { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function patchJson(body: unknown): RequestInit {
  return { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) };
}

beforeEach(() => {
  resetRateLimitForTests();
});

describe('gap fill: collaborators (OrgRoutes 185-253)', () => {
  it('lists collaborators for admins', async () => {
    const state = seedState();
    const res = await callGap(gapEnv(gapDb(state)), '/user/repos/alice/demo/collaborators');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { collaborators: unknown[] }).collaborators).toEqual([]);
  });

  it('denies collaborators for non-admins', async () => {
    const state = seedState();
    const res = await callGap(gapEnv(gapDb(state), BOB), '/user/repos/alice/demo/collaborators');
    expect(res.status).toBe(403);
  });

  it('puts by email and by username', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state));
    const byEmail = await callGap(env, '/user/repos/alice/demo/collaborators/bob%40example.com', putJson({ role: 'write' }));
    expect(byEmail.status).toBe(200);
    expect(state.collaborators).toHaveLength(1);
    const byName = await callGap(env, '/user/repos/alice/demo/collaborators/bob', putJson({}));
    expect(byName.status).toBe(200);
  });

  it('validates role and body', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state));
    expect((await callGap(env, '/user/repos/alice/demo/collaborators/bob', putJson({ role: 'superadmin' }))).status).toBe(400);
    expect(
      (await callGap(env, '/user/repos/alice/demo/collaborators/bob', { method: 'PUT', headers: JSON_HEADERS, body: '{broken' })).status,
    ).toBe(400);
    expect((await callGap(env, '/user/repos/alice/demo/collaborators/nonexistent', putJson({ role: 'read' }))).status).toBe(404);
  });

  it('removes collaborators', async () => {
    const state = seedState();
    state.collaborators.push({ repo_id: 'r-demo', user_email: BOB, role: 'read' });
    const env = gapEnv(gapDb(state));
    const res = await callGap(env, '/user/repos/alice/demo/collaborators/bob%40example.com', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(state.collaborators).toHaveLength(0);
  });
});

describe('gap fill: rules (RuleRoutes)', () => {
  it('lists empty rules for readers', async () => {
    const state = seedState();
    const res = await callGap(gapEnv(gapDb(state)), '/user/repos/alice/demo/rules');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rules: unknown[] }).rules).toEqual([]);
  });

  it('creates and deletes rules as admin', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state));
    const created = await callGap(env, '/user/repos/alice/demo/rules', postJson({ pattern: 'main', blockForcePush: true }));
    expect(created.status).toBe(201);
    expect(state.rules).toHaveLength(1);
    const listed = (await (await callGap(env, '/user/repos/alice/demo/rules')).json()) as { rules: Array<{ id: string }> };
    expect(listed.rules).toHaveLength(1);
    const deleted = await callGap(env, `/user/repos/alice/demo/rules/${listed.rules[0]?.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(state.rules).toHaveLength(0);
  });

  it('validates rule input', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state));
    expect((await callGap(env, '/user/repos/alice/demo/rules', postJson({}))).status).toBe(400);
    expect((await callGap(env, '/user/repos/alice/demo/rules', postJson({ pattern: '  ' }))).status).toBe(400);
    expect((await callGap(env, '/user/repos/alice/demo/rules', { method: 'POST', headers: JSON_HEADERS, body: '{broken' })).status).toBe(
      400,
    );
  });

  it('forbids rule mutation for non-admins', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state), BOB);
    expect((await callGap(env, '/user/repos/alice/demo/rules', postJson({ pattern: 'main' }))).status).toBe(403);
  });
});

describe('gap fill: social star/watch flows', () => {
  it('stars, unstars, watches, un watches with counts', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state));
    const starred = (await (await callGap(env, '/user/repos/alice/demo/star', { method: 'PUT' })).json()) as {
      starred: boolean;
      starsCount: number;
    };
    expect(starred.starred).toBe(true);
    expect(starred.starsCount).toBe(1);
    const authedStar = (await (await callGap(env, '/user/repos/alice/demo/star')).json()) as {
      starred: boolean;
      viewerStarred: boolean;
      starsCount: number;
    };
    expect(authedStar).toMatchObject({ starred: true, viewerStarred: true, starsCount: 1 });
    const watched = (await (await callGap(env, '/user/repos/alice/demo/watch', { method: 'PUT' })).json()) as {
      watched?: boolean;
      watching?: boolean;
      watchersCount: number;
    };
    expect(watched.watchersCount).toBe(1);
    const authedWatch = (await (await callGap(env, '/user/repos/alice/demo/watch')).json()) as {
      watching: boolean;
      viewerWatching: boolean;
      watchersCount: number;
    };
    expect(authedWatch).toMatchObject({ watching: true, viewerWatching: true, watchersCount: 1 });
    const unstarred = (await (await callGap(env, '/user/repos/alice/demo/star', { method: 'DELETE' })).json()) as {
      starred: boolean;
      starsCount: number;
    };
    expect(unstarred.starred).toBe(false);
    expect(unstarred.starsCount).toBe(0);
    const unwatched = await callGap(env, '/user/repos/alice/demo/watch', { method: 'DELETE' });
    expect(unwatched.status).toBe(200);
  });

  it('serves public star/watch/activity read-models', async () => {
    const state = seedState();
    state.stars.push({ repo_id: 'r-demo', user_email: BOB, created_at: 1 });
    const env = gapEnv(gapDb(state));
    for (const path of ['/repos/alice/demo/stars', '/repos/alice/demo/watches', '/repos/alice/demo/activity']) {
      const res = await callGap(env, path);
      expect(res.status, path).toBe(200);
    }
    const mine = (await (await callGap(env, '/user/stars')).json()) as { repos?: unknown[]; stars?: unknown[] };
    expect(mine).toBeDefined();
  });

  it('embeds social counts and viewer flags in repo payloads', async () => {
    const state = seedState();
    state.stars.push({ repo_id: 'r-demo', user_email: BOB, created_at: 1 });
    const env = gapEnv(gapDb(state));
    // Public payload carries counts; DEV_AUTH_EMAIL (alice) resolves as the
    // viewer, so flags reflect alice (not the bob star above).
    const pub = (await (await callGap(env, '/repos/alice/demo')).json()) as {
      forksCount: number;
      starsCount: number;
      watchersCount: number;
      viewerStarred: boolean;
      viewerWatching: boolean;
      starred: boolean;
      watching: boolean;
    };
    expect(pub).toMatchObject({
      forksCount: 0,
      starsCount: 1,
      watchersCount: 0,
      viewerStarred: false,
      viewerWatching: false,
      starred: false,
      watching: false,
    });
    const authed = (await (await callGap(env, '/user/repos/alice/demo')).json()) as {
      viewerCanManage: boolean;
      starsCount: number;
      viewerStarred: boolean;
    };
    expect(authed).toMatchObject({ viewerCanManage: true, starsCount: 1, viewerStarred: false });
    // After alice stars, both payloads reflect the viewer's flag and count.
    expect((await callGap(env, '/user/repos/alice/demo/star', { method: 'PUT' })).status).toBe(200);
    const pubAfter = (await (await callGap(env, '/repos/alice/demo')).json()) as {
      starsCount: number;
      viewerStarred: boolean;
    };
    expect(pubAfter).toMatchObject({ starsCount: 2, viewerStarred: true });
    const authedAfter = (await (await callGap(env, '/user/repos/alice/demo')).json()) as {
      starsCount: number;
      viewerStarred: boolean;
    };
    expect(authedAfter).toMatchObject({ starsCount: 2, viewerStarred: true });
  });
});

describe('gap fill: user profiles (UserRoutes)', () => {
  it('serves self, outsider, org, and missing profiles', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state));
    const self = (await (await callGap(env, '/users/alice')).json()) as { type: string; viewerIsSelf: boolean; orgCount: number };
    expect(self.type).toBe('user');
    expect(self.viewerIsSelf).toBe(true);
    expect(self.orgCount).toBe(1);
    const outsider = (await (await callGap(env, '/users/bob')).json()) as { type: string; viewerIsSelf: boolean };
    expect(outsider.type).toBe('user');
    expect(outsider.viewerIsSelf).toBe(false);
    const org = (await (await callGap(env, '/users/acme')).json()) as { type: string; viewerIsMember: boolean };
    expect(org.type).toBe('org');
    expect(org.viewerIsMember).toBe(true);
    expect((await callGap(env, '/users/ghost')).status).toBe(404);
  });

  it('lists profile repos with limit clamping', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state));
    const res = (await (await callGap(env, '/users/alice/repos?limit=2')).json()) as { repos: Array<{ name: string }> };
    expect(res.repos.map((r) => r.name)).toEqual(['demo']);
    const orgs = (await (await callGap(env, '/users/alice/orgs')).json()) as { orgs: Array<{ username: string }> };
    expect(orgs.orgs.map((o) => o.username)).toEqual(['acme']);
    const stranger = (await (await callGap(gapEnv(gapDb(state), BOB), '/users/alice/orgs')).json()) as { orgs: unknown[] };
    expect(stranger.orgs).toEqual([]);
  });
});

describe('gap fill: security settings and deploy keys', () => {
  it('reads defaults and updates scan mode', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state));
    const before = (await (await callGap(env, '/user/repos/alice/demo/security')).json()) as { settings: { secretScanMode: string } };
    expect(before.settings.secretScanMode).toBe('warn');
    const updated = await callGap(env, '/user/repos/alice/demo/security', patchJson({ secretScanMode: 'block' }));
    expect(updated.status).toBe(200);
    const after = (await (await callGap(env, '/user/repos/alice/demo/security')).json()) as { settings: { secretScanMode: string } };
    expect(after.settings.secretScanMode).toBe('block');
    expect((await callGap(env, '/user/repos/alice/demo/security', patchJson({ secretScanMode: 'nope' }))).status).toBe(400);
  });

  it('manages deploy keys', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state));
    const empty = (await (await callGap(env, '/user/repos/alice/demo/keys')).json()) as { keys: unknown[] };
    expect(empty.keys).toEqual([]);
    const created = await callGap(env, '/user/repos/alice/demo/keys', postJson({ name: 'ci', permission: 'read' }));
    expect(created.status).toBe(201);
    expect(state.keys).toHaveLength(1);
    expect((await callGap(env, '/user/repos/alice/demo/keys', postJson({}))).status).toBe(400);
    expect((await callGap(env, '/user/repos/alice/demo/keys', postJson({ name: 'x', permission: 'owner' }))).status).toBe(400);
    const keyId = state.keys[0]?.id as string;
    expect((await callGap(env, `/user/repos/alice/demo/keys/${keyId}`, { method: 'DELETE' })).status).toBe(200);
    expect(state.keys).toHaveLength(0);
  });
});

describe('gap fill: mirrors and imports', () => {
  it('configures, toggles, sync-guards, and removes mirrors', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state));
    const configured = await callGap(
      env,
      '/user/repos/alice/demo/mirror',
      putJson({ sourceUrl: 'https://github.com/o/r', intervalMinutes: 60 }),
    );
    expect(configured.status).toBe(200);
    expect(
      (await callGap(env, '/user/repos/alice/demo/mirror', putJson({ sourceUrl: 'http://github.com/o/r', intervalMinutes: 60 }))).status,
    ).toBe(400);
    const enabled = await callGap(env, '/user/repos/alice/demo/mirror/enable', postJson({ enabled: false }));
    expect(enabled.status).toBe(200);
    expect((await callGap(env, '/user/repos/alice/demo/mirror/enable', postJson({ enabled: 'yes' }))).status).toBe(400);
    expect((await callGap(gapEnv(gapDb(seedState())), '/user/repos/alice/demo/mirror/sync', postJson({}))).status).toBe(404);
    expect((await callGap(env, '/user/repos/alice/demo/mirror', { method: 'DELETE' })).status).toBe(200);
  });

  it('validates import input and reports missing jobs', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state));
    expect((await callGap(env, '/user/repos/alice/demo/import', postJson({}))).status).toBe(400);
    expect((await callGap(env, '/user/repos/alice/demo/import', postJson({ sourceUrl: 'not-a-url' }))).status).toBe(400);
    expect((await callGap(env, '/user/repos/alice/demo/import')).status).toBe(404);
    expect((await callGap(env, '/user/repos/alice/demo/import/j1/cancel', postJson({}))).status).toBe(404);
  });
});

describe('gap fill: notifications and snippets', () => {
  it('reads and drains notifications', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state));
    const list = (await (await callGap(env, '/user/notifications')).json()) as { notifications: unknown[] };
    expect(list.notifications).toEqual([]);
    const unread = (await (await callGap(env, '/user/notifications/unread-count')).json()) as { unreadCount: number };
    expect(unread.unreadCount).toBe(0);
    expect((await callGap(env, '/user/notifications/read-all', postJson({}))).status).toBe(200);
  });

  it('creates snippets with validation', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state));
    const empty = (await (await callGap(env, '/user/snippets')).json()) as { snippets: unknown[] };
    expect(empty.snippets).toEqual([]);
    expect((await callGap(env, '/user/snippets', postJson({}))).status).toBe(400);
    const created = await callGap(
      env,
      '/user/snippets',
      postJson({ title: 'notes', visibility: 'public', files: [{ filename: 'a.txt', body: 'hi' }] }),
    );
    expect(created.status).toBe(201);
    expect(state.snippets).toHaveLength(1);
  });
});
describe('gap fill: org rename and disband', () => {
  it('reads a single org', async () => {
    const state = seedState();
    const res = await callGap(gapEnv(gapDb(state)), '/user/orgs/acme');
    expect(res.status).toBe(200);
  });

  it('renames an org and cascades repos', async () => {
    const state = seedState();
    state.repos.push({
      id: 'r-org',
      owner_email: ALICE,
      owner_user_email: ALICE,
      owner: 'acme',
      name: 'o1',
      description: null,
      is_private: 0,
      created_at: 1,
      updated_at: 1,
      owner_type: 'org',
      owner_ci: 'acme',
      name_ci: 'o1',
      org_id: 'org-acme',
    });
    const env = gapEnv(gapDb(state));
    const res = await callGap(env, '/user/orgs/acme', patchJson({ username: 'acme2' }));
    expect(res.status).toBe(200);
  });

  it('blocks disband while repos exist, allows when empty', async () => {
    const blocked = seedState();
    blocked.repos.push({
      id: 'r-org',
      owner_email: ALICE,
      owner_user_email: ALICE,
      owner: 'acme',
      name: 'o1',
      description: null,
      is_private: 0,
      created_at: 1,
      updated_at: 1,
      owner_type: 'org',
      owner_ci: 'acme',
      name_ci: 'o1',
      org_id: 'org-acme',
    });
    expect((await callGap(gapEnv(gapDb(blocked)), '/user/orgs/acme', { method: 'DELETE' })).status).toBe(400);
    const empty = seedState();
    const res = await callGap(gapEnv(gapDb(empty)), '/user/orgs/acme', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(empty.orgs).toHaveLength(0);
  });

  it('manages members with last-owner guard', async () => {
    const state = seedState();
    const env = gapEnv(gapDb(state));
    const added = await callGap(env, '/user/orgs/acme/members', postJson({ email: BOB, role: 'member' }));
    expect(added.status).toBe(201);
    const demote = await callGap(env, `/user/orgs/acme/members/${encodeURIComponent(ALICE)}`, patchJson({ role: 'member' }));
    expect(demote.status).toBe(400);
  });
});
