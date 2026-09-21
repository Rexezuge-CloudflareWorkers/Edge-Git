import { describe, expect, it } from 'vitest';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { TeamService } from '@edge-git/backend-services/team';
import { ImportService } from '@edge-git/backend-services/transfer';
import { UserService } from '@edge-git/backend-services/user';
import { WebhookDeliveryService } from '@edge-git/backend-services/webhook';

// In-memory D1 fake in the test/services.test.ts style: per-table arrays
// with prepare/bind/first/all/run dispatch on the normalized SQL.
type Row = Record<string, any>;

interface FakeState {
  organizations: Row[];
  organization_members: Row[];
  teams: Row[];
  team_members: Row[];
  team_repo_grants: Row[];
  users: Row[];
  namespaces: Row[];
  repositories: Row[];
  repo_imports: Row[];
  repo_webhooks: Row[];
  webhook_deliveries: Row[];
}

type FakeDb = D1Queryable & FakeState;

function emptyState(): FakeState {
  return {
    organizations: [],
    organization_members: [],
    teams: [],
    team_members: [],
    team_repo_grants: [],
    users: [],
    namespaces: [],
    repositories: [],
    repo_imports: [],
    repo_webhooks: [],
    webhook_deliveries: [],
  };
}

const lower = (value: unknown): string => String(value).toLowerCase();

// Mutate in place: `db` exposes the same array references, so run() handlers
// must never reassign state arrays (db would keep the stale reference).
function removeInPlace(rows: Row[], predicate: (row: Row) => boolean): number {
  let removed = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (!predicate(rows[i])) {
      continue;
    }

    rows.splice(i, 1);
    removed += 1;
  }
  return removed;
}

function createFakeDb(seed?: Partial<FakeState>): FakeDb {
  const state: FakeState = { ...emptyState(), ...seed };

  function statement(query: string, params: unknown[]) {
    const q = query.replaceAll(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        // Organizations
        if (q.includes('FROM organizations WHERE username_ci')) {
          const row = state.organizations.find((o) => o.username_ci === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        // Organization members
        if (q.includes('FROM organization_members') && q.includes('COUNT(*)')) {
          const n = state.organization_members.filter((m) => m.org_id === params[0] && m.role === 'owner').length;
          return Promise.resolve({ n } as unknown as T);
        }
        if (q.includes('FROM organization_members WHERE org_id = ? AND lower(user_email)')) {
          const row = state.organization_members.find((m) => m.org_id === params[0] && lower(m.user_email) === lower(params[1]));
          return Promise.resolve((row ?? null) as T | null);
        }
        // Teams
        if (q.includes('FROM teams WHERE org_id = ? AND slug_ci')) {
          const row = state.teams.find((t) => t.org_id === params[0] && t.slug_ci === lower(params[1]));
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('COUNT(*)') && q.includes('FROM teams')) {
          const n = state.teams.filter((t) => t.org_id === params[0]).length;
          return Promise.resolve({ n } as unknown as T);
        }
        if (q.includes('FROM teams WHERE id = ?')) {
          const row = state.teams.find((t) => t.id === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        // Team members
        if (q.includes('FROM team_members') && q.includes("role = 'admin'")) {
          const n = state.team_members.filter((m) => m.team_id === params[0] && m.role === 'admin').length;
          return Promise.resolve({ n } as unknown as T);
        }
        if (q.includes('FROM team_members WHERE team_id = ? AND lower(user_email)')) {
          const row = state.team_members.find((m) => m.team_id === params[0] && lower(m.user_email) === lower(params[1]));
          return Promise.resolve((row ?? null) as T | null);
        }
        // Team repo grants
        if (q.includes('COUNT(*)') && q.includes('FROM team_repo_grants')) {
          const n = state.team_repo_grants.filter((g) => g.team_id === params[0]).length;
          return Promise.resolve({ n } as unknown as T);
        }
        if (q.includes('FROM team_repo_grants WHERE team_id = ? AND repo_id = ?')) {
          const row = state.team_repo_grants.find((g) => g.team_id === params[0] && g.repo_id === params[1]);
          return Promise.resolve((row ?? null) as T | null);
        }
        // Users
        if (q.includes('FROM users WHERE lower(email)')) {
          const row = state.users.find((u) => lower(u.email) === lower(params[0]));
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM users WHERE lower(username)')) {
          const row = state.users.find((u) => u.username != null && lower(u.username) === lower(params[0]));
          return Promise.resolve((row ?? null) as T | null);
        }
        // Namespaces
        if (q.includes('FROM namespaces WHERE username_ci')) {
          const row = state.namespaces.find((n) => n.username_ci === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        // Repositories
        if (q.includes('FROM repositories WHERE id = ?')) {
          const row = state.repositories.find((r) => r.id === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        // Repo imports
        if (q.includes('FROM repo_imports WHERE repository_id = ? AND status IN')) {
          const row = state.repo_imports.find((r) => r.repository_id === params[0] && (r.status === 'pending' || r.status === 'running'));
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM repo_imports WHERE repository_id = ? ORDER BY')) {
          const rows = state.repo_imports
            .filter((r) => r.repository_id === params[0])
            .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
          return Promise.resolve((rows[0] ?? null) as unknown as T | null);
        }
        if (q.includes('FROM repo_imports WHERE id = ?')) {
          const row = state.repo_imports.find((r) => r.id === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        // Webhooks
        if (q.includes('FROM repo_webhooks WHERE id = ? AND repository_id = ?')) {
          const row = state.repo_webhooks.find((h) => h.id === params[0] && h.repository_id === params[1]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM repo_webhooks WHERE id = ?')) {
          const row = state.repo_webhooks.find((h) => h.id === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        // Deliveries
        if (q.includes('FROM webhook_deliveries WHERE id = ?')) {
          const row = state.webhook_deliveries.find((d) => d.id === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM teams WHERE org_id = ? ORDER BY')) {
          const rows = state.teams.filter((t) => t.org_id === params[0]).slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM team_members WHERE team_id = ? ORDER BY')) {
          const rows = state.team_members.filter((m) => m.team_id === params[0]).slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM team_members WHERE lower(user_email)')) {
          const rows = state.team_members.filter((m) => lower(m.user_email) === lower(params[0])).slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM team_repo_grants WHERE team_id = ? ORDER BY')) {
          const rows = state.team_repo_grants.filter((g) => g.team_id === params[0]).slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM repositories WHERE lower(owner) = ? ORDER BY')) {
          const rows = state.repositories.filter((r) => lower(r.owner) === lower(params[0])).slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM repositories WHERE owner = ? ORDER BY')) {
          const rows = state.repositories.filter((r) => r.owner === params[0]).slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM repo_webhooks WHERE repository_id = ? ORDER BY')) {
          const rows = state.repo_webhooks.filter((h) => h.repository_id === params[0]);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes("FROM webhook_deliveries WHERE status = 'pending' AND next_retry_at <=")) {
          const rows = state.webhook_deliveries
            .filter((d) => d.status === 'pending' && d.next_retry_at <= (params[0] as number))
            .sort((a, b) => a.next_retry_at - b.next_retry_at || (a.id < b.id ? -1 : 1))
            .slice(0, params[1] as number);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM webhook_deliveries WHERE hook_id = ?')) {
          const hookId = params[0] as string;
          let rows = state.webhook_deliveries
            .filter((d) => d.hook_id === hookId)
            .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
          if (params.length > 2) {
            const cursor = { created_at: params[1] as number, id: params[3] as string };
            rows = rows.filter((d) => d.created_at < cursor.created_at || (d.created_at === cursor.created_at && d.id < cursor.id));
          }
          const pageSize = params.at(-1) as number;
          return Promise.resolve({ results: rows.slice(0, pageSize) as T[] });
        }
        if (q.includes('FROM repo_imports WHERE')) {
          const rows = state.repo_imports
            .filter((r) => r.repository_id === params[1] || r.status === 'pending')
            .slice(0, params.at(-1) as number);
          return Promise.resolve({ results: rows as T[] });
        }
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        // Teams
        if (q.startsWith('INSERT INTO teams (id, org_id, slug')) {
          const [id, orgId, slug, slugCi, name, description, createdBy, createdAt, updatedAt] = params as Array<string | number | null>;
          state.teams.push({
            id,
            org_id: orgId,
            slug,
            slug_ci: slugCi,
            name,
            description,
            created_by: createdBy,
            created_at: createdAt,
            updated_at: updatedAt,
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE teams SET slug')) {
          const [slug, slugCi, name, description, now, id] = params as Array<string | number | null>;
          const row = state.teams.find((t) => t.id === id);
          if (row) {
            row.slug = slug;
            row.slug_ci = slugCi;
            row.name = name;
            row.description = description;
            row.updated_at = now;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM teams WHERE id = ?')) {
          const removed = removeInPlace(state.teams, (t) => t.id === params[0]);
          return Promise.resolve({ success: true, meta: { changes: removed } });
        }
        // Organization members
        if (q.startsWith('DELETE FROM organization_members WHERE org_id = ? AND lower(user_email)')) {
          removeInPlace(
            state.organization_members,
            (m) => m.org_id === params[0] && lower(m.user_email) === lower(params[1]) && m.user_email !== params[2],
          );
          return Promise.resolve({ success: true, meta: { changes: 0 } });
        }
        if (q.startsWith('INSERT INTO organization_members (org_id, user_email, role, created_at)')) {
          const [orgId, userEmail, role, now] = params as Array<string | number>;
          const existing = state.organization_members.find((m) => m.org_id === orgId && lower(m.user_email) === lower(userEmail));
          if (existing) existing.role = role;
          else state.organization_members.push({ org_id: orgId, user_email: userEmail, role, created_at: now });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // Team members (legacy-dedupe variant carries a third binding)
        if (q.startsWith('DELETE FROM team_members WHERE team_id = ? AND lower(user_email)') && q.includes('AND user_email != ?')) {
          removeInPlace(
            state.team_members,
            (m) => m.team_id === params[0] && lower(m.user_email) === lower(params[1]) && m.user_email !== params[2],
          );
          return Promise.resolve({ success: true, meta: { changes: 0 } });
        }
        if (q.startsWith('DELETE FROM team_members WHERE team_id = ? AND lower(user_email)')) {
          const removed = removeInPlace(state.team_members, (m) => m.team_id === params[0] && lower(m.user_email) === lower(params[1]));
          return Promise.resolve({ success: true, meta: { changes: removed } });
        }
        if (q.startsWith('INSERT INTO team_members (team_id, user_email, role, joined_at)')) {
          const [teamId, userEmail, role, now] = params as Array<string | number>;
          const existing = state.team_members.find((m) => m.team_id === teamId && lower(m.user_email) === lower(userEmail));
          if (existing) existing.role = role;
          else state.team_members.push({ team_id: teamId, user_email: userEmail, role, joined_at: now });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM team_members WHERE team_id = ?')) {
          const removed = removeInPlace(state.team_members, (m) => m.team_id === params[0]);
          return Promise.resolve({ success: true, meta: { changes: removed } });
        }
        // Team repo grants
        if (q.startsWith('INSERT INTO team_repo_grants')) {
          const [teamId, repoId, role, grantedBy, now] = params as Array<string | number | null>;
          const existing = state.team_repo_grants.find((g) => g.team_id === teamId && g.repo_id === repoId);
          if (existing) existing.role = role;
          else state.team_repo_grants.push({ team_id: teamId, repo_id: repoId, role, granted_by: grantedBy, created_at: now });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM team_repo_grants WHERE team_id = ? AND repo_id = ?')) {
          const removed = removeInPlace(state.team_repo_grants, (g) => g.team_id === params[0] && g.repo_id === params[1]);
          return Promise.resolve({ success: true, meta: { changes: removed } });
        }
        if (q.startsWith('DELETE FROM team_repo_grants WHERE team_id = ?')) {
          const removed = removeInPlace(state.team_repo_grants, (g) => g.team_id === params[0]);
          return Promise.resolve({ success: true, meta: { changes: removed } });
        }
        // Users
        if (q.startsWith('INSERT INTO users (email, created_at)')) {
          const [email, now] = params as Array<string | number>;
          if (state.users.every((u) => u.email !== email)) {
            state.users.push({ email, created_at: now, username: null, updated_at: null });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE users SET username = COALESCE(username, ?)')) {
          const [username, now, email] = params as Array<string | number>;
          const row = state.users.find((u) => lower(u.email) === lower(email));
          if (row) {
            if (row.username == null) row.username = username;
            if (row.updated_at == null) row.updated_at = now;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE users SET username = ?, updated_at = ? WHERE email = ?')) {
          const [username, now, email] = params as Array<string | number>;
          const row = state.users.find((u) => lower(u.email) === lower(email));
          if (row) {
            row.username = username;
            row.updated_at = now;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // Namespaces (plain INSERT must throw on conflict like real D1)
        if (q.startsWith('INSERT OR IGNORE INTO namespaces')) {
          const [usernameCi, kind, userEmail, orgId, now] = params as Array<string | number | null>;
          if (state.namespaces.every((n) => n.username_ci !== usernameCi)) {
            state.namespaces.push({ username_ci: usernameCi, kind, user_email: userEmail, org_id: orgId, created_at: now });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO namespaces (username_ci')) {
          const [usernameCi, kind, userEmail, orgId, now] = params as Array<string | number | null>;
          if (state.namespaces.some((n) => n.username_ci === usernameCi)) {
            throw new Error('UNIQUE constraint failed: namespaces.username_ci');
          }
          state.namespaces.push({ username_ci: usernameCi, kind, user_email: userEmail, org_id: orgId, created_at: now });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM namespaces WHERE username_ci = ?')) {
          const removed = removeInPlace(state.namespaces, (n) => n.username_ci === params[0]);
          return Promise.resolve({ success: true, meta: { changes: removed } });
        }
        // Repo imports
        if (q.startsWith('INSERT INTO repo_imports (id, repository_id')) {
          const [id, repositoryId, sourceUrl, status, createdBy, createdAt, updatedAt] = params as Array<string | number>;
          state.repo_imports.push({
            id,
            repository_id: repositoryId,
            source_url: sourceUrl,
            status,
            error: null,
            refs_json: null,
            imported_refs: 0,
            created_by: createdBy,
            created_at: createdAt,
            updated_at: updatedAt,
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes("UPDATE repo_imports SET status = 'cancelled'")) {
          const row = state.repo_imports.find((r) => r.id === params[1]);
          if (row && (row.status === 'pending' || row.status === 'running')) {
            row.status = 'cancelled';
            row.updated_at = params[0];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes("UPDATE repo_imports SET status = 'running'")) {
          const row = state.repo_imports.find((r) => r.id === params[1]);
          if (row && (row.status === 'pending' || row.status === 'running')) {
            row.status = 'running';
            row.updated_at = params[0];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes("UPDATE repo_imports SET status = 'done'")) {
          const row = state.repo_imports.find((r) => r.id === params[3]);
          if (row) {
            row.status = 'done';
            row.refs_json = params[0];
            row.imported_refs = params[1];
            row.updated_at = params[2];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes("UPDATE repo_imports SET status = 'failed'")) {
          const row = state.repo_imports.find((r) => r.id === params[2]);
          if (row) {
            row.status = 'failed';
            row.error = params[0];
            row.updated_at = params[1];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // Webhook deliveries
        if (q.startsWith('INSERT INTO webhook_deliveries (id, hook_id')) {
          const [id, hookId, repositoryId, event, eventId, payload, nextRetryAt, createdAt, updatedAt] = params as Array<
            string | number | null
          >;
          state.webhook_deliveries.push({
            id,
            hook_id: hookId,
            repository_id: repositoryId,
            event,
            event_id: eventId,
            payload,
            status: 'pending',
            attempts: 0,
            next_retry_at: nextRetryAt,
            last_http_status: null,
            last_error: null,
            created_at: createdAt,
            updated_at: updatedAt,
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes('UPDATE webhook_deliveries SET attempts = attempts + 1')) {
          const row = state.webhook_deliveries.find((d) => d.id === params[1]);
          if (!row || row.status !== 'pending') return Promise.resolve({ success: true, meta: { changes: 0 } });
          row.attempts += 1;
          row.updated_at = params[0];
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE webhook_deliveries SET status = ?, next_retry_at')) {
          const [status, nextRetryAt, httpStatus, error, now, id] = params as Array<string | number | null>;
          const row = state.webhook_deliveries.find((d) => d.id === id);
          if (row) {
            row.status = status;
            row.next_retry_at = nextRetryAt;
            row.last_http_status = httpStatus;
            row.last_error = error;
            row.updated_at = now;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes("UPDATE webhook_deliveries SET status = 'pending', attempts = 0")) {
          const row = state.webhook_deliveries.find((d) => d.id === params[2]);
          if (row) {
            row.status = 'pending';
            row.attempts = 0;
            row.next_retry_at = params[0];
            row.last_http_status = null;
            row.last_error = null;
            row.updated_at = params[1];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM webhook_deliveries WHERE id IN (')) {
          const doomed = state.webhook_deliveries.filter((d) => d.created_at < (params[0] as number)).slice(0, params[1] as number);
          const doomedIds = new Set(doomed.map((d) => d.id));
          removeInPlace(state.webhook_deliveries, (d) => doomedIds.has(d.id));
          return Promise.resolve({ success: true, meta: { changes: doomed.length } });
        }
        // Webhook outcome accounting
        if (q.includes('UPDATE repo_webhooks SET last_delivery_at') && q.includes('consecutive_failures + 1')) {
          const hook = state.repo_webhooks.find((h) => h.id === params[4]);
          if (hook) {
            hook.last_delivery_at = params[0];
            hook.last_delivery_status = params[1];
            hook.consecutive_failures += 1;
            if (hook.consecutive_failures >= (params[2] as number)) hook.is_active = 0;
            hook.updated_at = params[3];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.includes('UPDATE repo_webhooks SET last_delivery_at')) {
          const hook = state.repo_webhooks.find((h) => h.id === params[3]);
          if (hook) {
            hook.last_delivery_at = params[0];
            hook.last_delivery_status = params[1];
            hook.consecutive_failures = 0;
            hook.updated_at = params[2];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // Repositories (rename cascade)
        if (q.startsWith('UPDATE repositories SET owner = ?, owner_ci = ?, updated_at = ? WHERE owner_ci = ?')) {
          for (const r of state.repositories) {
            if (lower(r.owner_ci ?? r.owner) !== lower(params[3])) {
              continue;
            }

            r.owner = params[0];
            r.owner_ci = lower(params[1]);
            r.updated_at = params[2];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE repositories SET owner = ?, owner_ci = ?, updated_at = ? WHERE lower(owner) = ?')) {
          for (const r of state.repositories) {
            if (lower(r.owner) !== lower(params[3])) {
              continue;
            }

            r.owner = params[0];
            r.owner_ci = lower(params[1]);
            r.updated_at = params[2];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE repositories SET owner = ?, owner_ci = ? WHERE lower(owner) = ?')) {
          for (const r of state.repositories) {
            if (lower(r.owner) !== lower(params[2])) {
              continue;
            }

            r.owner = params[0];
            r.owner_ci = lower(params[1]);
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE repositories SET forked_from_full_name')) {
          for (const r of state.repositories) {
            if (r.forked_from_repo_id === params[1]) r.forked_from_full_name = params[0];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      },
    };
  }

  const db = { ...state, prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) };
  return db as unknown as FakeDb;
}

function seedAcme(db: FakeDb): void {
  db.organizations.push({ id: 'org1', username: 'acme', username_ci: 'acme', creator_email: 'owner@x.co', created_at: 1, updated_at: 1 });
  db.organization_members.push(
    { org_id: 'org1', user_email: 'owner@x.co', role: 'owner', created_at: 1 },
    { org_id: 'org1', user_email: 'member@x.co', role: 'member', created_at: 1 },
  );
  db.repositories.push({
    id: 'r1',
    owner_email: 'owner@x.co',
    owner: 'acme',
    name: 'demo',
    description: null,
    is_private: 0,
    created_at: 1,
    updated_at: 1,
  });
}

function seedHook(db: FakeDb, patch: Partial<Row> = {}): Row {
  const hook: Row = {
    id: 'h1',
    repository_id: 'r1',
    full_name: 'acme/demo',
    url: 'https://example.com/hook',
    url_prefix: 'https://example.com/hook',
    secret: 's3cret',
    secret_suffix: 'cret',
    events: '["push"]',
    is_active: 1,
    consecutive_failures: 0,
    last_delivery_at: null,
    last_delivery_status: null,
    creator_email: 'owner@x.co',
    created_at: 100,
    updated_at: 100,
    ...patch,
  };
  db.repo_webhooks.push(hook);
  return hook;
}

describe('TeamService teams', () => {
  it('creates, renames, and deletes a team', async () => {
    const db = createFakeDb();
    seedAcme(db);
    const svc = new TeamService({ DB: db });
    const created = await svc.createTeam('acme', 'owner@x.co', { slug: 'frontend' });
    expect(created.slug_ci).toBe('frontend');
    expect(created.name).toBe('frontend');

    await expect(svc.createTeam('ACME', 'owner@x.co', { slug: 'Frontend' })).rejects.toThrow('already exists');
    await expect(svc.createTeam('acme', 'owner@x.co', { slug: 'bad slug!' })).rejects.toThrow('Invalid team name');
    await expect(svc.createTeam('acme', 'member@x.co', { slug: 'other' })).rejects.toThrow('owners');
    await expect(svc.createTeam('missing', 'owner@x.co', { slug: 'other' })).rejects.toThrow('Organization not found');

    const renamed = await svc.renameTeam('acme', 'frontend', 'owner@x.co', { slug: 'web', name: 'Web Team' });
    expect(renamed.slug).toBe('web');
    expect(renamed.name).toBe('Web Team');
    await expect(svc.renameTeam('acme', 'web', 'member@x.co', { name: 'Nope' })).rejects.toThrow('owners');

    await svc.createTeam('acme', 'owner@x.co', { slug: 'api' });
    await expect(svc.renameTeam('acme', 'web', 'owner@x.co', { slug: 'API' })).rejects.toThrow('already exists');
    await expect(svc.renameTeam('acme', 'web', 'owner@x.co', { slug: 'nope!' })).rejects.toThrow('Invalid team name');

    await expect(svc.listTeams('acme', 'member@x.co')).resolves.toHaveLength(2);
    await expect(svc.listTeams('acme', 'stranger@x.co')).rejects.toThrow('members');
    await svc.deleteTeam('acme', 'web', 'owner@x.co');
    await expect(svc.requireTeam('acme', 'web')).rejects.toThrow('Team not found');
  });

  it('enforces the per-org team limit', async () => {
    const db = createFakeDb();
    seedAcme(db);
    const svc = new TeamService({ DB: db, MAX_TEAMS_PER_ORG: '1' });
    await svc.createTeam('acme', 'owner@x.co', { slug: 'one' });
    await expect(svc.createTeam('acme', 'owner@x.co', { slug: 'two' })).rejects.toThrow('Maximum of 1 teams reached');
  });

  it('validates team slugs statically', () => {
    expect(() => TeamService.validateTeamSlug('ok-name1')).not.toThrow();
    expect(() => TeamService.validateTeamSlug('bad name')).toThrow('Invalid team name');
  });
});

describe('TeamService members', () => {
  it('adds members and guards the last admin', async () => {
    const db = createFakeDb();
    seedAcme(db);
    db.users.push({ email: 'u@x.co', created_at: 1, username: 'bob', updated_at: 1 });
    const svc = new TeamService({ DB: db });
    await svc.createTeam('acme', 'owner@x.co', { slug: 'frontend' });

    await expect(svc.addMember('acme', 'frontend', 'member@x.co', 'new@x.co')).rejects.toThrow('owners or team admins');
    await expect(svc.addMember('acme', 'frontend', 'owner@x.co', 'new@x.co', 'super' as never)).rejects.toThrow('Invalid role');
    await svc.addMember('acme', 'frontend', 'owner@x.co', 'a@x.co', 'admin');
    // Team admins can manage membership too.
    await svc.addMember('acme', 'frontend', 'a@x.co', 'bob');
    await expect(svc.addMember('acme', 'frontend', 'owner@x.co', 'ghost')).rejects.toThrow('User not found');
    expect(await svc.listMemberEmails('acme', 'frontend')).toEqual(['a@x.co', 'u@x.co']);

    // Last-admin guards.
    await expect(svc.setMemberRole('acme', 'frontend', 'owner@x.co', 'a@x.co', 'member')).rejects.toThrow('last team admin');
    await expect(svc.removeMember('acme', 'frontend', 'owner@x.co', 'a@x.co')).rejects.toThrow('last team admin');
    await expect(svc.removeMember('acme', 'frontend', 'owner@x.co', 'nobody@x.co')).rejects.toThrow('Member not found');
    await expect(svc.setMemberRole('acme', 'frontend', 'owner@x.co', 'nobody@x.co', 'member')).rejects.toThrow('Member not found');
    await expect(svc.setMemberRole('acme', 'frontend', 'owner@x.co', 'a@x.co', 'weird' as never)).rejects.toThrow('Invalid role');

    await svc.addMember('acme', 'frontend', 'owner@x.co', 'b@x.co', 'admin');
    await svc.setMemberRole('acme', 'frontend', 'owner@x.co', 'a@x.co', 'member');
    await svc.removeMember('acme', 'frontend', 'owner@x.co', 'a@x.co');
    const members = await svc.listMembers('acme', 'frontend', 'member@x.co');
    expect(members.map((m) => m.username).sort()).toEqual(['bob', 'ghost']);
    // Unknown users resolve to ghost instead of leaking email or failing the list.
    expect(members.find((m) => m.username === 'ghost')).toMatchObject({ role: 'admin' });
    expect(members.every((m) => !('email' in m))).toBe(true);
    await expect(svc.listMembers('acme', 'frontend', 'stranger@x.co')).rejects.toThrow('members');
  });

  it('enforces the per-team member limit', async () => {
    const db = createFakeDb();
    seedAcme(db);
    const svc = new TeamService({ DB: db, MAX_TEAM_MEMBERS: '1' });
    await svc.createTeam('acme', 'owner@x.co', { slug: 'frontend' });
    await svc.addMember('acme', 'frontend', 'owner@x.co', 'a@x.co');
    await expect(svc.addMember('acme', 'frontend', 'owner@x.co', 'b@x.co')).rejects.toThrow('Maximum of 1 team members reached');
  });
});

describe('TeamService grants', () => {
  it('grants, lists, and revokes repo access', async () => {
    const db = createFakeDb();
    seedAcme(db);
    const svc = new TeamService({ DB: db });
    await svc.createTeam('acme', 'owner@x.co', { slug: 'frontend' });

    await expect(svc.grantRepo('acme', 'frontend', 'owner@x.co', 'r1', 'super' as never)).rejects.toThrow('Invalid role');
    await expect(svc.grantRepo('acme', 'frontend', 'member@x.co', 'r1', 'read')).rejects.toThrow('owners');
    await expect(svc.grantRepo('acme', 'frontend', 'owner@x.co', 'missing', 'read')).rejects.toThrow('Repository not found');
    await svc.grantRepo('acme', 'frontend', 'owner@x.co', 'r1', 'write');
    // Re-granting updates the role without tripping the limit.
    await svc.grantRepo('acme', 'frontend', 'owner@x.co', 'r1', 'admin');
    await expect(svc.listGrants('acme', 'frontend', 'member@x.co')).resolves.toEqual([{ repoId: 'r1', role: 'admin' }]);
    await expect(svc.listGrants('acme', 'frontend', 'stranger@x.co')).rejects.toThrow('members');
    await svc.revokeGrant('acme', 'frontend', 'owner@x.co', 'r1');
    await expect(svc.listGrants('acme', 'frontend', 'owner@x.co')).resolves.toEqual([]);
  });

  it('enforces the per-team grant limit', async () => {
    const db = createFakeDb();
    seedAcme(db);
    db.repositories.push({
      id: 'r2',
      owner: 'acme',
      name: 'other',
      owner_email: 'o@x.co',
      description: null,
      is_private: 0,
      created_at: 1,
      updated_at: 1,
    });
    const svc = new TeamService({ DB: db, MAX_TEAM_GRANTS: '1' });
    await svc.createTeam('acme', 'owner@x.co', { slug: 'frontend' });
    await svc.grantRepo('acme', 'frontend', 'owner@x.co', 'r1', 'read');
    await expect(svc.grantRepo('acme', 'frontend', 'owner@x.co', 'r2', 'read')).rejects.toThrow('Maximum of 1 repository grants reached');
  });

  it('cascades members and grants on team delete', async () => {
    const db = createFakeDb();
    seedAcme(db);
    const svc = new TeamService({ DB: db });
    await svc.createTeam('acme', 'owner@x.co', { slug: 'frontend' });
    await svc.addMember('acme', 'frontend', 'owner@x.co', 'a@x.co', 'admin');
    await svc.grantRepo('acme', 'frontend', 'owner@x.co', 'r1', 'read');
    await svc.deleteTeam('acme', 'frontend', 'owner@x.co');
    expect(db.team_members).toHaveLength(0);
    expect(db.team_repo_grants).toHaveLength(0);
    expect(db.teams).toHaveLength(0);
  });
});

describe('ImportService', () => {
  const source = 'https://github.com/octocat/hello-world';

  it('creates jobs and rejects duplicate active imports', async () => {
    const db = createFakeDb();
    const svc = new ImportService({ DB: db });
    const job = await svc.createJob('repo1', `${source}.git`, 'Alice@X.co');
    expect(job.repositoryId).toBe('repo1');
    expect(job.status).toBe('pending');
    expect(job.createdBy).toBe('alice@x.co');
    await expect(svc.createJob('repo1', source, 'alice@x.co')).rejects.toThrow('already in progress');
    await expect(svc.createJob('repo1', 'http://github.com/octocat/hello-world')).rejects.toThrow('https');
    await expect(svc.createJob('repo1', 'https://127.0.0.1/x.git')).rejects.toThrow('private');
    await expect(svc.latestForRepo('repo1')).resolves.toMatchObject({ repositoryId: 'repo1' });
    await expect(svc.latestForRepo('other')).resolves.toBeNull();
  });

  it('cancels pending jobs but rejects invalid statuses', async () => {
    const db = createFakeDb();
    const svc = new ImportService({ DB: db });
    const job = await svc.createJob('repo1', source, 'alice@x.co');
    const cancelled = await svc.cancelJob(job.id);
    expect(cancelled.status).toBe('cancelled');
    await expect(svc.cancelJob(job.id)).rejects.toThrow('already cancelled');

    const done = await svc.createJob('repo2', source, 'alice@x.co');
    const row = db.repo_imports.find((r) => r.id === done.id);
    row.status = 'done';
    await expect(svc.cancelJob(done.id)).rejects.toThrow('already done');
    await expect(svc.cancelJob('missing')).rejects.toThrow('Import not found');
  });

  it('returns transfer limits with defaults and overrides', () => {
    const db = createFakeDb();
    expect(new ImportService({ DB: db }).transferLimits()).toEqual({
      maxRefs: 2000,
      maxPackBytes: 52_428_800,
      timeoutMs: 20_000,
      staleSeconds: 600,
    });
    expect(
      new ImportService({ DB: db, MAX_IMPORT_REFS: '5', MAX_IMPORT_BYTES: '7', IMPORT_CLAIM_STALE_SECONDS: '9' }).transferLimits(),
    ).toEqual({ maxRefs: 5, maxPackBytes: 7, timeoutMs: 20_000, staleSeconds: 9 });
  });

  it('validates import statuses and maps metadata refs', () => {
    const db = createFakeDb();
    const svc = new ImportService({ DB: db });
    expect(svc.importStatus('pending')).toBe('pending');
    expect(() => svc.importStatus('bogus')).toThrow('Invalid import status');
    const base = {
      id: 'j1',
      repository_id: 'r1',
      source_url: source,
      status: 'done',
      error: null,
      refs_json: null,
      imported_refs: 0,
      created_by: 'a@x.co',
      created_at: 1,
      updated_at: 1,
    };
    expect(ImportService.toMetadata({ ...base, refs_json: 'not-json' }).refs).toBeNull();
    expect(ImportService.toMetadata({ ...base, refs_json: '[{"x":1}]' }).refs).toEqual([{ x: 1 }]);
    expect(ImportService.toMetadata({ ...base, refs_json: '{"a":1}' }).refs).toBeNull();
  });
});

describe('UserService upsert/bootstrap', () => {
  it('bootstraps usernames idempotently', async () => {
    const db = createFakeDb();
    const svc = new UserService({ DB: db });
    await svc.upsertUser('Alice@Example.com');
    await svc.upsertUser('alice@example.com');
    expect(db.users).toHaveLength(1);
    await expect(svc.getProfileByEmail('alice@example.com')).resolves.toEqual({ email: 'alice@example.com', username: 'alice' });
    await expect(svc.getProfileByEmail('missing@x.co')).rejects.toThrow('User not found');
    await expect(svc.getByUsername('alice')).resolves.toMatchObject({ email: 'alice@example.com' });
    await expect(svc.getByUsername('missing')).resolves.toBeNull();
  });

  it('suffixes colliding usernames', async () => {
    const db = createFakeDb();
    db.users.push({ email: 'other@x.co', created_at: 1, username: 'bob', updated_at: 1 });
    db.namespaces.push({ username_ci: 'bob', kind: 'user', user_email: 'other@x.co', org_id: null, created_at: 1 });
    db.organizations.push({ id: 'o1', username: 'carol', username_ci: 'carol', creator_email: 'c@x.co', created_at: 1, updated_at: 1 });
    db.users.push({ email: 'dave@t.co', created_at: 1, username: 'dave', updated_at: 1 });
    const svc = new UserService({ DB: db });
    await svc.upsertUser('bob@example.com');
    await expect(svc.getProfileByEmail('bob@example.com')).resolves.toMatchObject({ username: 'bob-1' });
    await svc.upsertUser('admin@example.com');
    await expect(svc.getProfileByEmail('admin@example.com')).resolves.toMatchObject({ username: 'admin-1' });
    await svc.upsertUser('carol@example.com');
    await expect(svc.getProfileByEmail('carol@example.com')).resolves.toMatchObject({ username: 'carol-1' });
    await svc.upsertUser('dave@example.com');
    await expect(svc.getProfileByEmail('dave@example.com')).resolves.toMatchObject({ username: 'dave-1' });
  });

  it('validates usernames statically', () => {
    expect(() => UserService.validateUsername('good-name1')).not.toThrow();
    expect(() => UserService.validateUsername('bad name')).toThrow('Invalid username');
    expect(() => UserService.validateUsername('admin')).toThrow('reserved');
  });
});

describe('UserService rename', () => {
  function seedAlice(db: FakeDb): void {
    db.users.push({ email: 'alice@example.com', created_at: 1, username: 'alice', updated_at: 1 });
    db.namespaces.push({ username_ci: 'alice', kind: 'user', user_email: 'alice@example.com', org_id: null, created_at: 1 });
  }

  it('renames and keeps the old name reserved', async () => {
    const db = createFakeDb();
    seedAlice(db);
    db.repositories.push({
      id: 'repo1',
      owner: 'alice',
      name: 'demo',
      owner_email: 'alice@example.com',
      description: null,
      is_private: 0,
      created_at: 1,
      updated_at: 1,
    });
    const svc = new UserService({ DB: db });
    const renamed = await svc.renameUsername('alice@example.com', 'Alice2');
    expect(renamed).toEqual({ email: 'alice@example.com', username: 'Alice2' });
    // Old handle stays reserved: the namespace row is never released, so
    // renaming (back) onto it reports taken instead of hijacking the handle.
    expect(db.namespaces.some((n) => n.username_ci === 'alice')).toBe(true);
    await expect(svc.renameUsername('alice@example.com', 'alice')).rejects.toThrow('already taken');
    // Owner cascade follows the rename.
    expect(db.repositories[0].owner).toBe('Alice2');
    // Same-handle rename is a no-op returning the stored row.
    await expect(svc.renameUsername('alice@example.com', 'ALICE2')).resolves.toMatchObject({ username: 'Alice2' });
  });

  it('reclaims a self-owned namespace when the claim races', async () => {
    // Pre-check sees a free name, but claim() loses a race; the existing row
    // belongs to the caller, so the rename proceeds without releasing.
    let released = 0;
    const svc = new UserService({ DB: {} } as never, {
      userDAO: async () =>
        ({
          getByEmail: async () => ({ email: 'alice@example.com', username: 'alice' }),
          getByUsernameCi: async () => null,
          setUsername: async () => undefined,
        }) as never,
      namespaceDAO: async () =>
        ({
          isTaken: async () => false,
          claim: async () => {
            throw new Error('UNIQUE constraint failed: namespaces.username_ci');
          },
          get: async () => ({ username_ci: 'alice2', kind: 'user', user_email: 'alice@example.com', org_id: null, created_at: 1 }),
          release: async () => {
            released += 1;
          },
        }) as never,
      organizationDAO: async () => ({ getByUsernameCi: async () => null }) as never,
      repositoryDAO: async () =>
        ({
          listByOwner: async () => [],
          renameOwner: async () => undefined,
          updateForkSourceFullName: async () => undefined,
        }) as never,
    });
    await expect(svc.renameUsername('alice@example.com', 'alice2')).resolves.toEqual({
      email: 'alice@example.com',
      username: 'alice2',
    });
    expect(released).toBe(0);
  });

  it('rolls back a fresh namespace claim when setUsername fails', async () => {
    let released: string | null = null;
    const svc = new UserService({ DB: {} } as never, {
      userDAO: async () =>
        ({
          getByEmail: async () => ({ email: 'alice@example.com', username: 'alice' }),
          getByUsernameCi: async () => null,
          setUsername: async () => {
            throw new Error('D1 busy');
          },
        }) as never,
      namespaceDAO: async () =>
        ({
          isTaken: async () => false,
          claim: async () => undefined,
          get: async () => null,
          release: async (ci: string) => {
            released = ci;
          },
        }) as never,
      organizationDAO: async () => ({ getByUsernameCi: async () => null }) as never,
      repositoryDAO: async () =>
        ({
          listByOwner: async () => [],
          renameOwner: async () => undefined,
          updateForkSourceFullName: async () => undefined,
        }) as never,
    });
    await expect(svc.renameUsername('alice@example.com', 'alice2')).rejects.toThrow('D1 busy');
    expect(released).toBe('alice2');
  });

  it('rejects taken, invalid, reserved, and missing renames', async () => {
    const db = createFakeDb();
    seedAlice(db);
    db.users.push({ email: 'bob@x.co', created_at: 1, username: 'taken2', updated_at: 1 });
    db.namespaces.push({ username_ci: 'taken2', kind: 'user', user_email: 'bob@x.co', org_id: null, created_at: 1 });
    const svc = new UserService({ DB: db });
    await expect(svc.renameUsername('alice@example.com', 'taken2')).rejects.toThrow('already taken');
    await expect(svc.renameUsername('alice@example.com', 'bad name!')).rejects.toThrow('Invalid username');
    await expect(svc.renameUsername('alice@example.com', 'admin')).rejects.toThrow('reserved');
    await expect(svc.renameUsername('ghost@x.co', 'fresh')).rejects.toThrow('User not found');
  });

  it('falls back to legacy usernames when the namespace table is missing', async () => {
    const db = createFakeDb();
    db.users.push({ email: 'legacy@x.co', created_at: 1, username: 'legacy', updated_at: 1 });
    const throwing = {
      ...db,
      prepare: (query: string) => {
        if (query.includes('namespaces')) {
          return {
            bind: () => ({
              first: () => Promise.reject(new Error('no such table: namespaces')),
              all: () => Promise.reject(new Error('no such table: namespaces')),
              run: () => Promise.reject(new Error('no such table: namespaces')),
            }),
          };
        }
        return (db as unknown as Record<string, (q: string) => unknown>).prepare(query) as never;
      },
    } as unknown as D1Queryable & FakeState;
    const svc = new UserService({ DB: throwing });
    await expect(svc.renameUsername('legacy@x.co', 'legacy2')).resolves.toEqual({ email: 'legacy@x.co', username: 'legacy2' });
    await svc.upsertUser('fresh@x.co');
    expect(db.users.some((u) => u.email === 'fresh@x.co')).toBe(true);
  });
});

describe('WebhookDeliveryService statics', () => {
  it('classifies retryable statuses', () => {
    expect(WebhookDeliveryService.isRetryableHttpStatus(null)).toBe(true);
    expect(WebhookDeliveryService.isRetryableHttpStatus(429)).toBe(true);
    expect(WebhookDeliveryService.isRetryableHttpStatus(500)).toBe(true);
    expect(WebhookDeliveryService.isRetryableHttpStatus(503)).toBe(true);
    expect(WebhookDeliveryService.isRetryableHttpStatus(599)).toBe(true);
    expect(WebhookDeliveryService.isRetryableHttpStatus(200)).toBe(false);
    expect(WebhookDeliveryService.isRetryableHttpStatus(400)).toBe(false);
    expect(WebhookDeliveryService.isRetryableHttpStatus(404)).toBe(false);
  });

  it('follows the 1m/10m/1h/6h/24h backoff schedule', () => {
    expect(WebhookDeliveryService.backoffSecondsForAttempt(1)).toBe(60);
    expect(WebhookDeliveryService.backoffSecondsForAttempt(2)).toBe(600);
    expect(WebhookDeliveryService.backoffSecondsForAttempt(3)).toBe(3600);
    expect(WebhookDeliveryService.backoffSecondsForAttempt(4)).toBe(21_600);
    expect(WebhookDeliveryService.backoffSecondsForAttempt(5)).toBe(86_400);
    expect(WebhookDeliveryService.backoffSecondsForAttempt(6)).toBe(86_400);
    expect(WebhookDeliveryService.backoffSecondsForAttempt(0)).toBe(60);
  });
});

describe('WebhookDeliveryService attempt/process', () => {
  it('fails blocked URLs without POSTing', async () => {
    const db = createFakeDb();
    seedHook(db, { url: 'http://localhost/evil' });
    let posted = false;
    const svc = new WebhookDeliveryService(
      { DB: db },
      {
        postJson: () => {
          posted = true;
          return Promise.resolve({ httpStatus: 200, error: null });
        },
      },
    );
    const { enqueued } = await svc.enqueueForEvent({ repositoryId: 'r1', fullName: 'acme/demo', event: 'push', actorEmail: 'A@x.co' });
    expect(enqueued).toBe(1);
    // Enqueued rows carry wall-clock next_retry_at, so sweep just after now.
    const result = await svc.processDue({ now: Math.floor(Date.now() / 1000) + 5 });
    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    expect(posted).toBe(false);
    const row = db.webhook_deliveries[0];
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('Webhook URL is blocked.');
  });

  it('retries 5xx with backoff and settles 4xx as terminal', async () => {
    const db = createFakeDb();
    seedHook(db);
    const svc = new WebhookDeliveryService(
      { DB: db },
      { postJson: () => Promise.resolve({ httpStatus: 500, error: 'Webhook returned HTTP 500' }) },
    );
    await svc.enqueueForEvent({ repositoryId: 'r1', fullName: 'acme/demo', event: 'push', actorEmail: 'a@x.co' });
    const now = Math.floor(Date.now() / 1000) + 5;
    const result = await svc.processDue({ now });
    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    const row = db.webhook_deliveries[0];
    // Claim bumped attempts 0→1, attemptRow scheduled backoff for attempt 2 (10m).
    expect(row.status).toBe('pending');
    expect(row.next_retry_at).toBe(now + 600);
    expect(row.last_http_status).toBe(500);

    const terminal = new WebhookDeliveryService(
      { DB: db },
      { postJson: () => Promise.resolve({ httpStatus: 400, error: 'Webhook returned HTTP 400' }) },
    );
    db.webhook_deliveries[0].status = 'pending';
    db.webhook_deliveries[0].next_retry_at = now;
    const second = await terminal.processDue({ now });
    expect(second).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    expect(db.webhook_deliveries[0].status).toBe('failed');
    expect(db.repo_webhooks[0].consecutive_failures).toBe(1);
  });

  it('marks successes and records hook outcomes', async () => {
    const db = createFakeDb();
    seedHook(db);
    const svc = new WebhookDeliveryService({ DB: db }, { postJson: () => Promise.resolve({ httpStatus: 200, error: null }) });
    await svc.enqueueForEvent({ repositoryId: 'r1', fullName: 'acme/demo', event: 'push', actorEmail: 'a@x.co' });
    const result = await svc.processDue({ now: Math.floor(Date.now() / 1000) + 5 });
    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
    expect(db.webhook_deliveries[0].status).toBe('success');
    expect(db.repo_webhooks[0].consecutive_failures).toBe(0);
    expect(db.repo_webhooks[0].last_delivery_status).toBe('success');
  });

  it('fails deliveries for missing or disabled hooks', async () => {
    const db = createFakeDb();
    seedHook(db, { id: 'disabled', is_active: 0 });
    // Disabled hooks never fan out; the active hook fails inline on its
    // blocked URL so both processed rows end failed.
    seedHook(db, { id: 'blocked', url: 'http://localhost/evil' });
    const svc = new WebhookDeliveryService({ DB: db }, { postJson: () => Promise.resolve({ httpStatus: 200, error: null }) });
    await expect(svc.enqueueForEvent({ repositoryId: 'r1', fullName: 'acme/demo', event: 'push', actorEmail: 'a@x.co' })).resolves.toEqual({
      enqueued: 1,
    });
    // Orphan delivery pointing at a hook that does not exist.
    db.webhook_deliveries.push({
      id: 'orphan',
      hook_id: 'ghost',
      repository_id: 'r1',
      event: 'push',
      event_id: null,
      payload: '{}',
      status: 'pending',
      attempts: 0,
      next_retry_at: 10,
      last_http_status: null,
      last_error: null,
      created_at: 10,
      updated_at: 10,
    });
    const result = await svc.processDue({ now: Math.floor(Date.now() / 1000) + 5 });
    expect(result.processed).toBe(2);
    expect(result.failed).toBe(2);
    expect(db.webhook_deliveries.every((d) => d.status === 'failed')).toBe(true);
  });

  it('sends inline test pings', async () => {
    const db = createFakeDb();
    seedHook(db);
    const svc = new WebhookDeliveryService({ DB: db }, { postJson: () => Promise.resolve({ httpStatus: 200, error: null }) });
    const ping = await svc.sendTestPing('h1', 'r1', 'acme/demo', 'owner@x.co');
    expect(ping.status).toBe('success');
    expect(ping.event).toBe('ping');
    await expect(svc.sendTestPing('missing', 'r1', 'acme/demo', 'owner@x.co')).rejects.toThrow('Webhook not found.');
  });
});

describe('WebhookDeliveryService fan-out/lifecycle', () => {
  it('enqueues only active subscribed hooks and never throws', async () => {
    const db = createFakeDb();
    seedHook(db, { id: 'active' });
    seedHook(db, { id: 'inactive', is_active: 0 });
    seedHook(db, { id: 'other-event', events: '["issues"]' });
    seedHook(db, { id: 'bad-events', events: 'not-json' });
    const svc = new WebhookDeliveryService({ DB: db });
    await expect(svc.enqueueForEvent({ repositoryId: 'r1', fullName: 'acme/demo', event: 'push', actorEmail: 'a@x.co' })).resolves.toEqual({
      enqueued: 1,
    });
    await expect(svc.enqueueForEvent({ repositoryId: 'r1', fullName: 'acme/demo', event: 'star', actorEmail: 'a@x.co' })).resolves.toEqual({
      enqueued: 0,
    });
    await expect(svc.enqueueForEvent({ repositoryId: 'unknown', fullName: 'x/y', event: 'push', actorEmail: 'a@x.co' })).resolves.toEqual({
      enqueued: 0,
    });
  });

  it('lists, redelivers, and prunes deliveries', async () => {
    const db = createFakeDb();
    seedHook(db);
    const svc = new WebhookDeliveryService({ DB: db });
    await svc.enqueueForEvent({ repositoryId: 'r1', fullName: 'acme/demo', event: 'push', actorEmail: 'a@x.co' });
    const listed = await svc.listDeliveries('h1', 'r1');
    expect(listed.deliveries).toHaveLength(1);
    expect(listed.nextCursor).toBeNull();
    await expect(svc.listDeliveries('missing', 'r1')).rejects.toThrow('Webhook not found.');

    const id = db.webhook_deliveries[0].id as string;
    db.webhook_deliveries[0].status = 'failed';
    db.webhook_deliveries[0].attempts = 3;
    const redelivered = await svc.redeliver(id, 'r1');
    expect(redelivered.status).toBe('pending');
    expect(redelivered.attempts).toBe(0);
    await expect(svc.redeliver('missing', 'r1')).rejects.toThrow('Delivery not found.');
    await expect(svc.redeliver(id, 'other-repo')).rejects.toThrow('Delivery not found.');

    db.webhook_deliveries.push({
      id: 'old',
      hook_id: 'h1',
      repository_id: 'r1',
      event: 'push',
      event_id: null,
      payload: '{}',
      status: 'success',
      attempts: 1,
      next_retry_at: 1,
      last_http_status: 200,
      last_error: null,
      created_at: 100,
      updated_at: 100,
    });
    expect(await svc.pruneOlderThan(1000, 10)).toBe(1);
    expect(db.webhook_deliveries.some((d) => d.id === 'old')).toBe(false);
  });

  it('processes nothing when no deliveries are due', async () => {
    const db = createFakeDb();
    const svc = new WebhookDeliveryService({ DB: db });
    await expect(svc.processDue({ now: 999 })).resolves.toEqual({ processed: 0, succeeded: 0, failed: 0 });
  });
});
