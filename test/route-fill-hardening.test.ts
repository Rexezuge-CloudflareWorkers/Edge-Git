import { describe, expect, it } from 'vitest';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { SecuritySettingsDAO } from '@edge-git/backend-data/dao';
import { SecuritySettingsService } from '@edge-git/backend-services/security';
import { RealtimeService } from '@edge-git/backend-services/realtime';
import {
  emitWebhookEvent,
  flushDueWebhookDeliveries,
  publishCheckUpdate,
  publishLiveUpdate,
  recordAndNotify,
} from '@/workers/routes/SocialEmit';
import { triggerRequiredChecks } from '@/workers/routes/TriggerChecks';
import { isCrossRepoPull, isPackLimitError } from '@/workers/routes/CrossFork';
import { toSafeErrorMessage, toServiceStatus } from '@/workers/routes/PublicViewerResolver';
import { normalizeAssetContentType } from '@edge-git/shared/validation';
import { BadRequestError, NotFoundError } from '@edge-git/backend-errors';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

// Per-table in-memory D1 fake (no vi.mock). Route handlers run through the
// real composition root; assertions read `state` arrays directly.
function createFillFakeDb() {
  const state = {
    users: [
      { email: ALICE, username: 'alice', created_at: 1 },
      { email: BOB, username: 'bob', created_at: 1 },
    ] as Array<Record<string, unknown>>,
    namespaces: [
      { username_ci: 'alice', kind: 'user', user_email: ALICE, org_id: null },
      { username_ci: 'bob', kind: 'user', user_email: BOB, org_id: null },
      { username_ci: 'acme', kind: 'org', user_email: null, org_id: 'org-acme' },
    ] as Array<Record<string, unknown>>,
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
      {
        id: 'r-secret',
        owner_email: ALICE,
        owner_user_email: ALICE,
        owner: 'alice',
        name: 'secret',
        description: null,
        is_private: 1,
        created_at: 1,
        updated_at: 2,
        owner_type: 'user',
        owner_ci: 'alice',
        name_ci: 'secret',
        org_id: null,
      },
      {
        id: 'r-bob-secret',
        owner_email: BOB,
        owner_user_email: BOB,
        owner: 'bob',
        name: 'secret',
        description: null,
        is_private: 1,
        created_at: 1,
        updated_at: 2,
        owner_type: 'user',
        owner_ci: 'bob',
        name_ci: 'secret',
        org_id: null,
      },
    ] as Array<Record<string, unknown>>,
    organizations: [{ id: 'org-acme', username: 'acme', username_ci: 'acme', creator_email: ALICE, created_at: 1, updated_at: 1 }] as Array<
      Record<string, unknown>
    >,
    orgMembers: [{ org_id: 'org-acme', user_email: ALICE, role: 'owner', created_at: 1 }] as Array<Record<string, unknown>>,
    teams: [
      {
        id: 'team-dev',
        org_id: 'org-acme',
        slug: 'dev',
        slug_ci: 'dev',
        name: 'dev',
        description: null,
        created_by: ALICE,
        created_at: 1,
        updated_at: 1,
      },
    ] as Array<Record<string, unknown>>,
    teamMembers: [{ team_id: 'team-dev', user_email: ALICE, role: 'admin', joined_at: 1 }] as Array<Record<string, unknown>>,
    teamGrants: [] as Array<Record<string, unknown>>,
    collaborators: [] as Array<Record<string, unknown>>,
    projects: [] as Array<Record<string, unknown>>,
    projectColumns: [] as Array<Record<string, unknown>>,
    projectCards: [] as Array<Record<string, unknown>>,
    pulls: [
      {
        id: 'pr-1',
        repository_id: 'r-demo',
        full_name: 'alice/demo',
        number: 1,
        title: 'Feat',
        body: null,
        status: 'open',
        base_branch: 'main',
        head_branch: 'feat',
        base_oid: 'a'.repeat(40),
        head_oid: 'b'.repeat(40),
        merge_base_oid: 'a'.repeat(40),
        creator_email: ALICE,
        created_at: 1,
        updated_at: 1,
        is_draft: 0,
      },
    ] as Array<Record<string, unknown>>,
    threads: [] as Array<Record<string, unknown>>,
    releases: [] as Array<Record<string, unknown>>,
    releaseAssets: [] as Array<Record<string, unknown>>,
    checks: [] as Array<Record<string, unknown>>,
    security: [] as Array<Record<string, unknown>>,
    tokens: [] as Array<Record<string, unknown>>,
    tokenGrants: [] as Array<Record<string, unknown>>,
  };

  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    const P = (i: number): string => String(params[i] ?? '');
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('FROM users WHERE lower(email)')) {
          return Promise.resolve(
            (state.users.find((u) => String(u.email).toLowerCase() === P(0).toLowerCase()) ?? null) as T | null,
          );
        }
        if (q.includes('FROM users WHERE lower(username)')) {
          return Promise.resolve(
            (state.users.find((u) => String(u.username ?? '').toLowerCase() === P(0).toLowerCase()) ?? null) as T | null,
          );
        }
        if (q.includes('FROM users WHERE email = ?')) {
          return Promise.resolve((state.users.find((u) => u.email === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM namespaces WHERE username_ci = ?')) {
          return Promise.resolve((state.namespaces.find((n) => n.username_ci === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE lower(owner)')) {
          return Promise.resolve(
            (state.repos.find(
              (r) => String(r.owner).toLowerCase() === P(0).toLowerCase() && String(r.name).toLowerCase() === P(1).toLowerCase(),
            ) ?? null) as T | null,
          );
        }
        if (q.includes('FROM repositories WHERE owner = ? AND name = ?')) {
          return Promise.resolve((state.repos.find((r) => r.owner === params[0] && r.name === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE id = ?')) {
          return Promise.resolve((state.repos.find((r) => r.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM organizations WHERE username_ci = ?')) {
          return Promise.resolve((state.organizations.find((o) => o.username_ci === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM organizations WHERE id = ?')) {
          return Promise.resolve((state.organizations.find((o) => o.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM organization_members WHERE org_id = ? AND')) {
          return Promise.resolve(
            (state.orgMembers.find((m) => m.org_id === params[0] && String(m.user_email).toLowerCase() === P(1).toLowerCase()) ??
              null) as T | null,
          );
        }
        if (q.includes('COUNT(*) AS n FROM organization_members')) {
          return Promise.resolve({ n: state.orgMembers.filter((m) => m.org_id === params[0] && m.role === 'owner').length } as unknown as T);
        }
        if (q.includes('FROM teams WHERE org_id = ? AND slug_ci = ?')) {
          return Promise.resolve(
            (state.teams.find((t) => t.org_id === params[0] && String(t.slug_ci).toLowerCase() === P(1).toLowerCase()) ?? null) as T | null,
          );
        }
        if (q.includes('FROM teams WHERE id = ?')) {
          return Promise.resolve((state.teams.find((t) => t.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('COUNT(*) AS n FROM teams')) {
          return Promise.resolve({ n: state.teams.filter((t) => t.org_id === params[0]).length } as unknown as T);
        }
        if (q.includes('FROM team_members WHERE team_id = ? AND')) {
          return Promise.resolve(
            (state.teamMembers.find((m) => m.team_id === params[0] && String(m.user_email).toLowerCase() === P(1).toLowerCase()) ??
              null) as T | null,
          );
        }
        if (q.includes("COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'admin'")) {
          return Promise.resolve({ n: state.teamMembers.filter((m) => m.team_id === params[0] && m.role === 'admin').length } as unknown as T);
        }
        if (q.includes('FROM team_repo_grants WHERE team_id = ? AND repo_id = ?')) {
          return Promise.resolve(
            (state.teamGrants.find((g) => g.team_id === params[0] && g.repo_id === params[1]) ?? null) as T | null,
          );
        }
        if (q.includes('COUNT(*) AS n FROM team_repo_grants')) {
          return Promise.resolve({ n: state.teamGrants.filter((g) => g.team_id === params[0]).length } as unknown as T);
        }
        if (q.includes('FROM repo_collaborators WHERE repo_id = ? AND')) {
          return Promise.resolve(
            (state.collaborators.find((c) => c.repo_id === params[0] && String(c.user_email).toLowerCase() === P(1).toLowerCase()) ??
              null) as T | null,
          );
        }
        if (q.includes('FROM projects WHERE repository_id = ? AND number = ?')) {
          return Promise.resolve(
            (state.projects.find((p) => p.repository_id === params[0] && p.number === params[1]) ?? null) as T | null,
          );
        }
        if (q.includes('FROM projects WHERE id = ? AND repository_id = ?')) {
          return Promise.resolve(
            (state.projects.find((p) => p.id === params[0] && p.repository_id === params[1]) ?? null) as T | null,
          );
        }
        if (q.includes('COALESCE(MAX(number)') && q.includes('FROM projects')) {
          const max = state.projects.filter((p) => p.repository_id === params[0]).reduce((m, p) => Math.max(m, (p.number as number) ?? 0), 0);
          return Promise.resolve({ next_number: max + 1, max_n: max } as unknown as T);
        }
        if (q.includes('COUNT(*) AS count FROM projects')) {
          return Promise.resolve({ count: state.projects.filter((p) => p.repository_id === params[0]).length } as unknown as T);
        }
        if (q.includes('FROM project_columns WHERE id = ? AND project_id = ?')) {
          return Promise.resolve((state.projectColumns.find((c) => c.id === params[0] && c.project_id === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM project_cards WHERE id = ? AND project_id = ?')) {
          return Promise.resolve((state.projectCards.find((c) => c.id === params[0] && c.project_id === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM pull_requests WHERE repository_id = ? AND number = ?')) {
          return Promise.resolve(
            (state.pulls.find((p) => p.repository_id === params[0] && p.number === params[1]) ?? null) as T | null,
          );
        }
        if (q.includes('FROM pull_review_threads WHERE pull_request_id = ? AND id = ?')) {
          return Promise.resolve((state.threads.find((t) => t.pull_request_id === params[0] && t.id === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM releases WHERE repository_id = ? AND tag_name = ?')) {
          return Promise.resolve(
            (state.releases.find((r) => r.repository_id === params[0] && r.tag_name === params[1]) ?? null) as T | null,
          );
        }
        if (q.includes('FROM releases WHERE id = ? AND repository_id = ?')) {
          return Promise.resolve(
            (state.releases.find((r) => r.id === params[0] && r.repository_id === params[1]) ?? null) as T | null,
          );
        }
        if (q.includes('COUNT(*) AS count FROM releases')) {
          return Promise.resolve({ count: state.releases.filter((r) => r.repository_id === params[0]).length } as unknown as T);
        }
        if (q.includes('FROM release_assets WHERE') && q.includes('repository_id')) {
          const row = state.releaseAssets.find((a) => a.repository_id === params[0] && (a.id === params[1] || a.release_id === params[1]));
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM check_runs WHERE')) {
          return Promise.resolve(null);
        }
        if (q.includes('FROM repo_security_settings WHERE repository_id = ?')) {
          return Promise.resolve((state.security.find((s) => s.repository_id === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM user_access_tokens WHERE token_hash = ?')) {
          return Promise.resolve(
            (state.tokens.find((t) => t.token_hash === params[0] && (t.expires_at as number) > (params[1] as number)) ?? null) as T | null,
          );
        }
        if (q.includes('COUNT(*)')) return Promise.resolve({ n: 0, count: 0 } as unknown as T);
        if (q.includes('COALESCE(MAX(number)')) return Promise.resolve({ max_n: 0, next_number: 1 } as unknown as T);
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM repositories WHERE') && q.includes('owner_email')) {
          return Promise.resolve({
            results: state.repos.filter((r) => String(r.owner_email).toLowerCase() === P(0).toLowerCase()) as T[],
          });
        }
        if (q.includes('FROM repositories WHERE lower(owner) = ?')) {
          return Promise.resolve({ results: state.repos.filter((r) => String(r.owner).toLowerCase() === P(0).toLowerCase()) as T[] });
        }
        if (q.includes('FROM repositories WHERE org_id = ?')) {
          return Promise.resolve({ results: state.repos.filter((r) => r.org_id === params[0]) as T[] });
        }
        if (q.includes('FROM organization_members WHERE org_id = ? ORDER BY')) {
          return Promise.resolve({ results: state.orgMembers.filter((m) => m.org_id === params[0]) as T[] });
        }
        if (q.includes('FROM organization_members WHERE lower(user_email)')) {
          return Promise.resolve({
            results: state.orgMembers.filter((m) => String(m.user_email).toLowerCase() === P(0).toLowerCase()) as T[],
          });
        }
        if (q.includes('FROM teams WHERE org_id = ? ORDER BY')) {
          return Promise.resolve({ results: state.teams.filter((t) => t.org_id === params[0]) as T[] });
        }
        if (q.includes('FROM team_members WHERE team_id = ? ORDER BY')) {
          return Promise.resolve({ results: state.teamMembers.filter((m) => m.team_id === params[0]) as T[] });
        }
        if (q.includes('FROM team_members WHERE lower(user_email)')) {
          return Promise.resolve({
            results: state.teamMembers.filter((m) => String(m.user_email).toLowerCase() === P(0).toLowerCase()) as T[],
          });
        }
        if (q.includes('FROM team_repo_grants WHERE team_id = ? ORDER BY')) {
          return Promise.resolve({ results: state.teamGrants.filter((g) => g.team_id === params[0]) as T[] });
        }
        if (q.includes('FROM team_repo_grants WHERE repo_id = ? ORDER BY')) {
          return Promise.resolve({ results: state.teamGrants.filter((g) => g.repo_id === params[0]) as T[] });
        }
        if (q.includes('FROM team_repo_grants WHERE token_id = ?')) {
          return Promise.resolve({ results: state.tokenGrants.filter((g) => g.token_id === params[0]) as T[] });
        }
        if (q.includes('FROM repo_collaborators WHERE repo_id = ? ORDER BY')) {
          return Promise.resolve({ results: state.collaborators.filter((c) => c.repo_id === params[0]) as T[] });
        }
        if (q.includes('FROM projects WHERE repository_id = ?')) {
          return Promise.resolve({
            results: state.projects
              .filter((p) => p.repository_id === params[0])
              .sort((a, b) => (b.number as number) - (a.number as number)) as T[],
          });
        }
        if (q.includes('FROM project_columns WHERE project_id = ?')) {
          return Promise.resolve({ results: state.projectColumns.filter((c) => c.project_id === params[0]) as T[] });
        }
        if (q.includes('FROM project_cards WHERE project_id = ?')) {
          return Promise.resolve({ results: state.projectCards.filter((c) => c.project_id === params[0]) as T[] });
        }
        if (q.includes('FROM pull_review_threads WHERE pull_request_id = ?')) {
          return Promise.resolve({ results: state.threads.filter((t) => t.pull_request_id === params[0]) as T[] });
        }
        if (q.includes('FROM releases WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.releases.filter((r) => r.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM release_assets WHERE')) {
          return Promise.resolve({ results: state.releaseAssets.filter((a) => a.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM user_access_tokens WHERE')) {
          return Promise.resolve({
            results: state.tokens.filter((t) => String(t.user_email).toLowerCase() === P(0).toLowerCase()) as T[],
          });
        }
        return Promise.resolve({ results: [] as T[] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO users')) {
          if (!state.users.some((u) => u.email === params[0])) state.users.push({ email: params[0], created_at: params[1] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE users SET')) {
          const row = state.users.find((u) => String(u.email).toLowerCase() === String(params[params.length - 1]).toLowerCase());
          if (row && !row.username) row.username = params[0];
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO namespaces') || q.startsWith('INSERT OR IGNORE INTO namespaces')) {
          if (!state.namespaces.some((n) => n.username_ci === params[0]))
            state.namespaces.push({ username_ci: params[0], kind: params[1], user_email: params[2] ?? null, org_id: params[3] ?? null });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO organizations')) {
          state.organizations.push({ id: params[0], username: params[1], username_ci: params[2], creator_email: params[3], created_at: params[4], updated_at: params[5] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM organization_members WHERE org_id = ? AND lower(user_email)')) {
          state.orgMembers = state.orgMembers.filter(
            !(q.includes('user_email != ?'))
              ? (m) => !(m.org_id === params[0] && String(m.user_email).toLowerCase() === P(1).toLowerCase())
              : (m) => !(m.org_id === params[0] && String(m.user_email).toLowerCase() === P(1).toLowerCase() && m.user_email !== params[2]),
          );
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO organization_members')) {
          const existing = state.orgMembers.find((m) => m.org_id === params[0] && m.user_email === params[1]);
          if (existing) existing.role = params[2];
          else state.orgMembers.push({ org_id: params[0], user_email: params[1], role: params[2], created_at: params[3] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM organization_members WHERE org_id = ?')) {
          state.orgMembers = state.orgMembers.filter((m) => m.org_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO teams')) {
          state.teams.push({ id: params[0], org_id: params[1], slug: params[2], slug_ci: params[3], name: params[4], description: params[5], created_by: params[6], created_at: params[7], updated_at: params[8] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE teams SET')) {
          const row = state.teams.find((t) => t.id === params[5]);
          if (row) {
            row.slug = params[0];
            row.slug_ci = params[1];
            row.name = params[2];
            row.description = params[3];
            row.updated_at = params[4];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM teams WHERE id = ?')) {
          state.teams = state.teams.filter((t) => t.id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM team_members WHERE team_id = ? AND lower(user_email)')) {
          state.teamMembers = state.teamMembers.filter(
            !(q.includes('user_email != ?'))
              ? (m) => !(m.team_id === params[0] && String(m.user_email).toLowerCase() === P(1).toLowerCase())
              : (m) => !(m.team_id === params[0] && String(m.user_email).toLowerCase() === P(1).toLowerCase() && m.user_email !== params[2]),
          );
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO team_members')) {
          const existing = state.teamMembers.find((m) => m.team_id === params[0] && m.user_email === params[1]);
          if (existing) existing.role = params[2];
          else state.teamMembers.push({ team_id: params[0], user_email: params[1], role: params[2], joined_at: params[3] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM team_members WHERE team_id = ?')) {
          const hasEmail = params.length > 1;
          state.teamMembers = hasEmail
            ? state.teamMembers.filter((m) => !(m.team_id === params[0] && String(m.user_email).toLowerCase() === P(1).toLowerCase()))
            : state.teamMembers.filter((m) => m.team_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO team_repo_grants')) {
          const existing = state.teamGrants.find((g) => g.team_id === params[0] && g.repo_id === params[1]);
          if (existing) existing.role = params[2];
          else state.teamGrants.push({ team_id: params[0], repo_id: params[1], role: params[2], granted_by: params[3], created_at: params[4] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM team_repo_grants WHERE team_id = ? AND repo_id = ?')) {
          state.teamGrants = state.teamGrants.filter((g) => !(g.team_id === params[0] && g.repo_id === params[1]));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM team_repo_grants WHERE team_id = ?')) {
          state.teamGrants = state.teamGrants.filter((g) => g.team_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO repo_collaborators')) {
          const existing = state.collaborators.find((c) => c.repo_id === params[0] && c.user_email === params[1]);
          if (existing) existing.role = params[2];
          else state.collaborators.push({ repo_id: params[0], user_email: params[1], role: params[2], granted_by: params[3], created_at: params[4] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repo_collaborators WHERE repo_id = ? AND lower(user_email)')) {
          state.collaborators = state.collaborators.filter(
            !(q.includes('user_email != ?'))
              ? (c) => !(c.repo_id === params[0] && String(c.user_email).toLowerCase() === P(1).toLowerCase())
              : (c) => !(c.repo_id === params[0] && String(c.user_email).toLowerCase() === P(1).toLowerCase() && c.user_email !== params[2]),
          );
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO projects')) {
          state.projects.push({ id: params[0], repository_id: params[1], number: params[2], title: params[3], description: params[4], status: 'open', creator_email: params[5], created_at: params[6], updated_at: params[7] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE projects SET status = ?')) {
          const row = state.projects.find((p) => p.id === params[2] && p.repository_id === params[3]);
          if (row) {
            row.status = params[0];
            row.updated_at = params[1];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE projects SET')) {
          const id = params[params.length - 2];
          const row = state.projects.find((p) => p.id === id);
          if (row) {
            if (q.includes('title = ?')) row.title = params[0];
            row.updated_at = params[params.length - 3];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM projects WHERE id = ?')) {
          state.projects = state.projects.filter((p) => !(p.id === params[0] && p.repository_id === params[1]));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO project_columns')) {
          state.projectColumns.push({ id: params[0], project_id: params[1], title: params[2], position: params[3], created_at: params[4] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE project_columns SET title = ?')) {
          const row = state.projectColumns.find((c) => c.id === params[1] && c.project_id === params[2]);
          if (row) row.title = params[0];
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM project_columns WHERE id = ?')) {
          state.projectColumns = state.projectColumns.filter((c) => !(c.id === params[0] && c.project_id === params[1]));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM project_columns WHERE project_id = ?')) {
          state.projectColumns = state.projectColumns.filter((c) => c.project_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO project_cards')) {
          state.projectCards.push({ id: params[0], project_id: params[1], column_id: params[2], kind: params[3], note_title: params[4], note_body: params[5], issue_id: params[6], pull_request_id: params[7], position: params[8], archived: 0, creator_email: params[9], created_at: params[10], updated_at: params[11] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE project_cards SET column_id = ?')) {
          const row = state.projectCards.find((c) => c.id === params[3] && c.project_id === params[4]);
          if (row) {
            row.column_id = params[0];
            row.position = params[1];
            row.updated_at = params[2];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE project_cards SET archived = ?')) {
          const row = state.projectCards.find((c) => c.id === params[2] && c.project_id === params[3]);
          if (row) {
            row.archived = params[0];
            row.updated_at = params[1];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM project_cards WHERE id = ?')) {
          state.projectCards = state.projectCards.filter((c) => !(c.id === params[0] && c.project_id === params[1]));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM project_cards WHERE project_id = ?')) {
          state.projectCards = state.projectCards.filter((c) => c.project_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM project_cards WHERE column_id = ?')) {
          state.projectCards = state.projectCards.filter((c) => c.column_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO pull_review_threads')) {
          state.threads.push({ id: params[0], pull_request_id: params[1], path: params[2], line: params[3], side: params[4], commit_oid: params[5], status: 'open', author_email: params[7], created_at: params[8] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO releases')) {
          state.releases.push({ id: params[0], repository_id: params[1], tag_name: params[2], name: params[3], body: params[4], is_draft: params[5], is_prerelease: params[6], created_by: params[7], created_at: params[8], published_at: params[9] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE releases SET')) {
          const row = state.releases.find((r) => r.id === params[params.length - 1]);
          if (row && q.includes('is_draft')) row.is_draft = params[0];
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM releases WHERE')) {
          state.releases = state.releases.filter((r) => !(r.repository_id === params[0] && r.tag_name === params[1]));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO release_assets')) {
          state.releaseAssets.push({ id: params[0], release_id: params[1], repository_id: params[2], name: params[3], size: params[4], content_type: params[5], sha256: params[6], created_by: params[7], created_at: params[8] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM release_assets WHERE')) {
          state.releaseAssets = state.releaseAssets.filter((a) => !(a.repository_id === params[0]));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO check_runs')) {
          state.checks.push({ id: params[0], repository_id: params[1], head_sha: params[2], context: params[3] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO repo_security_settings')) {
          const existing = state.security.find((s) => s.repository_id === params[0]);
          if (existing) {
            existing.secret_scan_mode = params[1];
            existing.updated_by = params[2];
            existing.updated_at = params[3];
          } else {
            state.security.push({ repository_id: params[0], secret_scan_mode: params[1], updated_by: params[2], updated_at: params[3] });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repo_security_settings')) {
          state.security = state.security.filter((s) => s.repository_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO user_access_tokens')) {
          state.tokens.push({ token_id: params[0], user_email: params[1], token_hash: params[2], name: params[3], expires_at: params[4], last_used_at: null, created_at: params[5], scopes: params[6] ?? null, token_prefix: params[7] ?? null });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE user_access_tokens SET last_used_at')) {
          const row = state.tokens.find((t) => t.token_hash === params[1]);
          if (row) row.last_used_at = params[0];
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      },
    };
  }
  const db = { prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) };
  return { db: db as unknown as D1Queryable, state };
}

function createDoStub(emptyRefs = false) {
  return {
    setFullName: () => Promise.resolve(),
    ensureRepoInitialized: () => Promise.resolve(),
    deleteRepo: () => Promise.resolve(),
    listRefs: () =>
      Promise.resolve(emptyRefs ? { refs: [], symbolicHead: null } : { refs: [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }], symbolicHead: 'refs/heads/main' }),
    getBranches: () => Promise.resolve({ branches: ['main'], currentBranch: 'main' }),
    getTree: () => Promise.resolve([]),
    getBlob: () => Promise.resolve(null),
    getCommits: () => Promise.resolve([]),
    getTags: () => Promise.resolve([]),
    getOverview: () => Promise.resolve({ branches: ['main'], currentBranch: 'main', resolvedRef: 'a'.repeat(40), tags: [], tree: [], commits: [], readme: null }),
    getBlame: () => Promise.resolve([]),
    resolveRef: () => Promise.resolve('a'.repeat(40)),
    hasObject: () => Promise.resolve(false),
    createBranch: () => Promise.resolve({ ok: true, ref: 'refs/heads/x', oid: 'a'.repeat(40) }),
    deleteBranchRef: () => Promise.resolve({ ok: true }),
    setDefaultBranch: () => Promise.resolve({ ok: true }),
    commitFile: () => Promise.resolve({ ok: true, commitOid: 'c'.repeat(40), created: true }),
    exportPack: () => Promise.resolve({ oids: ['a'.repeat(40)], pack: new Uint8Array([1, 2, 3]) }),
    importPack: () => Promise.resolve({ importedRefs: ['refs/heads/main'] }),
    receivePack: () => Promise.resolve(new Response('ok')),
    fetch: () => Promise.resolve(new Response('PACK', { status: 200 })),
    mergePull: () => Promise.resolve({ ok: true }),
    getPullDiff: () => Promise.resolve({ mergeBase: 'a'.repeat(40), truncated: false, changes: [] }),
    getMergePreviewByOids: () => Promise.resolve({ baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40), mergeBase: null, truncated: false, files: [] }),
    getReleaseAsset: () => Promise.resolve(null),
    storeReleaseAsset: () => Promise.resolve({ ok: true }),
    deleteReleaseAsset: () => Promise.resolve({ ok: true }),
    deleteReleaseAssets: () => Promise.resolve({ ok: true }),
    enqueueChecks: () => Promise.resolve({ ok: true }),
  };
}

function createEnv(db: D1Queryable, overrides: Record<string, unknown> = {}) {
  const stub = createDoStub();
  return {
    DB: db,
    REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    CRON_TASKS: { get: () => stub, idFromName: (n: string) => n },
    CHECK_RUNNER: { get: () => stub, idFromName: (n: string) => n },
    REALTIME: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    ENVIRONMENT: 'development',
    DEV_AUTH_EMAIL: ALICE,
    ...overrides,
  };
}

function createAnonEnv(db: D1Queryable) {
  const stub = createDoStub();
  return {
    DB: db,
    REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    CRON_TASKS: { get: () => stub, idFromName: (n: string) => n },
    CHECK_RUNNER: { get: () => stub, idFromName: (n: string) => n },
    REALTIME: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    ENVIRONMENT: 'production',
  };
}

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function callWorker(env: unknown, path: string, init?: RequestInit): Promise<Response> {
  const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
  const res = await worker.onRequest(new Request(`https://git.example.com${path}`, init), env, CTX);
  return res;
}

function postJson(path: string, body: unknown, extraHeaders: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { ...JSON_HEADERS, ...extraHeaders }, body: JSON.stringify(body) };
}

describe('GitRoutes info/refs auth gates + pack limits', () => {
  it('rejects malformed owner/name with 401 oracle guard', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/bad%20owner/demo/info/refs?service=git-upload-pack');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
  });

  it('rejects unknown git service with 400', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/alice/demo/info/refs?service=git-nope');
    expect(res.status).toBe(400);
    await res.text();
  });

  it('advertises upload-pack anonymously for public repos', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createAnonEnv(db), '/alice/demo/info/refs?service=git-upload-pack');
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it('rejects anonymous receive-pack advertise with 401', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createAnonEnv(db), '/alice/demo/info/refs?service=git-receive-pack');
    expect(res.status).toBe(401);
  });

  it('returns 413 when the fetch body exceeds the limit', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createAnonEnv(db), '/alice/demo/git-upload-pack', {
      method: 'POST',
      headers: { 'Content-Length': '99999999', 'Content-Type': 'application/x-git-upload-pack-request' },
      body: new Uint8Array([1, 2, 3]) as unknown as BodyInit,
    });
    expect(res.status).toBe(413);
    expect(await res.text()).toContain('too large');
  });

  it('hides private repos from anonymous pushes with 401', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createAnonEnv(db), '/bob/secret/git-receive-pack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-git-receive-pack-request' },
      body: new Uint8Array([1]) as unknown as BodyInit,
    });
    expect(res.status).toBe(401);
  });
});

describe('ProjectRoutes CRUD + move validation', () => {
  it('creates a project and grows state', async () => {
    const { db, state } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/user/repos/alice/demo/projects', postJson('/x', { title: 'Board' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { project: { number: number; title: string } };
    expect(body.project.title).toBe('Board');
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0].repository_id).toBe('r-demo');
  });

  it('rejects project creation without a title', async () => {
    const { db, state } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/user/repos/alice/demo/projects', postJson('/x', { title: '' }));
    expect(res.status).toBe(400);
    expect(state.projects).toHaveLength(0);
  });

  it('rejects invalid project numbers with 400', async () => {
    const { db } = createFillFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, '/repos/alice/demo/projects/nope')).status).toBe(400);
    expect((await callWorker(env, '/user/repos/alice/demo/projects/0')).status).toBe(400);
  });

  it('rejects card creation without columnId', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/user/repos/alice/demo/projects/1/cards', postJson('/x', { kind: 'note' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { Exception?: { Type?: string; Message?: string } };
    expect(body.Exception?.Message ?? '').toContain('columnId');
  });

  it('rejects card moves without toColumnId', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(
      createEnv(db),
      '/user/repos/alice/demo/projects/1/cards/card-1/move',
      { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({}) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { Exception?: { Type?: string; Message?: string } };
    expect(body.Exception?.Message ?? '').toContain('toColumnId');
  });

  it('deletes a project and shrinks state', async () => {
    const { db, state } = createFillFakeDb();
    const env = createEnv(db);
    const created = await callWorker(env, '/user/repos/alice/demo/projects', postJson('/x', { title: 'Temp' }));
    expect(created.status).toBe(201);
    expect(state.projects).toHaveLength(1);
    const number = ((await created.json()) as { project: { number: number } }).project.number;
    const deleted = await callWorker(env, `/user/repos/alice/demo/projects/${number}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(state.projects).toHaveLength(0);
  });
});

describe('OrgRoutes last-owner guard', () => {
  it('requires a target when adding members', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/user/orgs/acme/members', postJson('/x', {}));
    expect(res.status).toBe(400);
  });

  it('rejects invalid member roles', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/user/orgs/acme/members', postJson('/x', { email: BOB, role: 'superadmin' }));
    expect(res.status).toBe(400);
  });

  it('refuses to remove the last owner and keeps state', async () => {
    const { db, state } = createFillFakeDb();
    const before = state.orgMembers.length;
    const res = await callWorker(createEnv(db), `/user/orgs/acme/members/${encodeURIComponent(ALICE)}`, { method: 'DELETE' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { Exception?: { Type?: string; Message?: string } };
    expect(body.Exception?.Message ?? '').toContain('last owner');
    expect(state.orgMembers).toHaveLength(before);
  });

  it('refuses to demote the last owner', async () => {
    const { db, state } = createFillFakeDb();
    const res = await callWorker(createEnv(db), `/user/orgs/acme/members/${encodeURIComponent(ALICE)}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: 'member' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { Exception?: { Type?: string; Message?: string } };
    expect(body.Exception?.Message ?? '').toContain('last owner');
    expect(state.orgMembers.find((m) => m.user_email === ALICE)?.role).toBe('owner');
  });
});

describe('TeamRoutes grants + member management', () => {
  it('requires a slug when creating teams', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/user/orgs/acme/teams', postJson('/x', { name: 'No Slug' }));
    expect(res.status).toBe(400);
  });

  it('requires a target when adding team members', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/user/orgs/acme/teams/dev/members', postJson('/x', {}));
    expect(res.status).toBe(400);
  });

  it('rejects invalid team member roles', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/user/orgs/acme/teams/dev/members', postJson('/x', { email: BOB, role: 'owner' }));
    expect(res.status).toBe(400);
  });

  it('rejects invalid repo grant roles', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/user/orgs/acme/teams/dev/repos/alice/demo', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: 'superadmin' }),
    });
    expect(res.status).toBe(400);
  });

  it('grants a repo and lists it with resolved fullName', async () => {
    const { db, state } = createFillFakeDb();
    const env = createEnv(db);
    const granted = await callWorker(env, '/user/orgs/acme/teams/dev/repos/alice/demo', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ role: 'read' }),
    });
    expect(granted.status).toBe(200);
    expect(state.teamGrants).toHaveLength(1);
    const listed = await callWorker(env, '/user/orgs/acme/teams/dev/repos');
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { repos: Array<{ repoId: string; fullName: string | null; role: string }> };
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0].fullName).toBe('alice/demo');
    const revoked = await callWorker(env, '/user/orgs/acme/teams/dev/repos/alice/demo', { method: 'DELETE' });
    expect(revoked.status).toBe(200);
    expect(state.teamGrants).toHaveLength(0);
  });
});

describe('PublicViewerResolver anon visibility', () => {
  it('returns 404 for anonymous reads of private repos', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createAnonEnv(db), '/repos/bob/secret');
    expect(res.status).toBe(404);
  });

  it('lets the owner read their private repo over /user routes', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/user/repos/alice/secret');
    expect(res.status).toBe(200);
  });

  it('maps service errors without leaking internals', () => {
    expect(toServiceStatus(new NotFoundError('gone'))).toBe(404);
    expect(toServiceStatus(new BadRequestError('bad'))).toBe(400);
    expect(toServiceStatus(new Error('D1 exploded: table missing'))).toBe(500);
    expect(toSafeErrorMessage(new Error('D1 exploded: table missing'), 'Not found')).toBe('Not found');
    expect(toSafeErrorMessage(new NotFoundError('gone'), 'Not found')).toBe('gone');
  });
});

describe('SocialEmit best-effort fan-out + inbox hashing', () => {
  it('recordAndNotify never throws and resolves', async () => {
    const { db } = createFillFakeDb();
    const env = createEnv(db);
    await expect(
      recordAndNotify(env as never, {
        repositoryId: 'r-demo',
        fullName: 'alice/demo',
        actorEmail: ALICE,
        type: 'push',
        title: 'Pushed to main',
      }),
    ).resolves.toBeUndefined();
  });

  it('webhook emit + flush never throw', async () => {
    const { db } = createFillFakeDb();
    const env = createEnv(db);
    await expect(
      emitWebhookEvent(env as never, { repositoryId: 'r-demo', fullName: 'alice/demo', actorEmail: ALICE, event: 'push', title: 'push' }),
    ).resolves.toBeUndefined();
    await expect(flushDueWebhookDeliveries(env as never)).resolves.toMatchObject({ processed: 0 });
  });

  it('live + check updates no-op safely when disabled or malformed', async () => {
    const { db } = createFillFakeDb();
    const env = createEnv(db);
    await expect(
      publishLiveUpdate(env as never, { fullName: 'alice/demo', channel: 'activity', type: 'push', actorEmail: ALICE, title: 'hi' }),
    ).resolves.toBeUndefined();
    await expect(
      publishCheckUpdate(env as never, { fullName: 'alice/demo', headSha: 'not-a-sha', context: 'ci', status: 'queued', actorEmail: ALICE }),
    ).resolves.toBeUndefined();
  });

  it('hashes inbox recipients deterministically', async () => {
    const first = await RealtimeService.hashRecipients([ALICE, BOB]);
    const second = await RealtimeService.hashRecipients([BOB, ALICE]);
    expect(first).toHaveLength(2);
    expect(new Set([...first, ...second]).size).toBe(2);
    expect((await RealtimeService.inboxHashForEmail(ALICE)).length).toBe(16);
  });
});

describe('SecuritySettingsDAO CRUD + warn-by-default', () => {
  it('returns null for repos without settings', async () => {
    const { db } = createFillFakeDb();
    const dao = new SecuritySettingsDAO(db);
    await expect(dao.getByRepo('r-demo')).resolves.toBeNull();
  });

  it('persists scan mode and asserts via state', async () => {
    const { db, state } = createFillFakeDb();
    const dao = new SecuritySettingsDAO(db);
    await dao.setScanMode('r-demo', 'block', ALICE, 42);
    expect(state.security).toHaveLength(1);
    expect(state.security[0]).toMatchObject({ repository_id: 'r-demo', secret_scan_mode: 'block', updated_by: ALICE, updated_at: 42 });
    await expect(dao.getByRepo('r-demo')).resolves.toMatchObject({ secret_scan_mode: 'block' });
  });

  it('overwrites mode on conflict', async () => {
    const { db, state } = createFillFakeDb();
    const dao = new SecuritySettingsDAO(db);
    await dao.setScanMode('r-demo', 'warn', ALICE, 1);
    await dao.setScanMode('r-demo', 'off', ALICE, 2);
    expect(state.security).toHaveLength(1);
    await expect(dao.getByRepo('r-demo')).resolves.toMatchObject({ secret_scan_mode: 'off', updated_at: 2 });
  });

  it('deletes settings by repo', async () => {
    const { db, state } = createFillFakeDb();
    const dao = new SecuritySettingsDAO(db);
    await dao.setScanMode('r-demo', 'block', ALICE, 1);
    await dao.deleteByRepo('r-demo');
    expect(state.security).toHaveLength(0);
    await expect(dao.getByRepo('r-demo')).resolves.toBeNull();
  });

  it('service defaults to warn and validates modes', async () => {
    const { db } = createFillFakeDb();
    const svc = new SecuritySettingsService({ DB: db });
    await expect(svc.getMode('r-demo')).resolves.toBe('warn');
    await expect(svc.getSettings('r-demo')).resolves.toMatchObject({ repositoryId: 'r-demo', secretScanMode: 'warn' });
    expect(SecuritySettingsService.normalizeMode('off')).toBe('off');
    expect(() => SecuritySettingsService.normalizeMode('nope')).toThrow('secretScanMode');
  });
});

describe('ReleaseAsset auth + content-type', () => {
  it('rejects uploads without name/content', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/user/repos/alice/demo/releases/v1/assets', postJson('/x', {}));
    expect(res.status).toBe(400);
  });

  it('rejects invalid base64 payloads', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(
      createEnv(db),
      '/user/repos/alice/demo/releases/v1/assets',
      postJson('/x', { name: 'a.zip', contentBase64: '!!!not-base64!!!' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects oversized assets with 413', async () => {
    const { db } = createFillFakeDb();
    const env = createEnv(db, { MAX_ASSET_BYTES: '16' });
    const big = Buffer.from('x'.repeat(64)).toString('base64');
    const res = await callWorker(env, '/user/repos/alice/demo/releases/v1/assets', postJson('/x', { name: 'a.zip', contentBase64: big }));
    expect(res.status).toBe(413);
  });

  it('normalizes unsafe content types to octet-stream', () => {
    expect(normalizeAssetContentType('text/html')).toBe('application/octet-stream');
    expect(normalizeAssetContentType('image/svg+xml')).toBe('application/octet-stream');
    expect(normalizeAssetContentType('application/zip')).toBe('application/zip');
    expect(normalizeAssetContentType('text/plain; charset=utf-8')).toBe('text/plain');
    expect(normalizeAssetContentType(undefined)).toBe('application/octet-stream');
  });
});

describe('Checks, threads, discussions, cross-fork helpers', () => {
  it('rejects check reports with invalid sha', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/user/repos/alice/demo/checks', postJson('/x', { headSha: 'short', context: 'ci' }));
    expect(res.status).toBe(400);
  });

  it('requires a status when updating checks', async () => {
    const { db } = createFillFakeDb();
    const res = await callWorker(createEnv(db), '/user/repos/alice/demo/checks/c1', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ conclusion: 'success' }),
    });
    expect(res.status).toBe(400);
  });

  it('triggerRequiredChecks never throws and skips invalid shas', async () => {
    const { db } = createFillFakeDb();
    const env = createEnv(db);
    await expect(
      triggerRequiredChecks(env as never, { repositoryId: 'r-demo', fullName: 'alice/demo', branch: 'main', headSha: 'bad', actorEmail: ALICE }),
    ).resolves.toEqual({ triggered: [] });
    await expect(
      triggerRequiredChecks(env as never, {
        repositoryId: 'r-demo',
        fullName: 'alice/demo',
        branch: 'main',
        headSha: '0'.repeat(40),
        actorEmail: ALICE,
      }),
    ).resolves.toEqual({ triggered: [] });
  });

  it('classifies pack-limit errors without false positives', () => {
    expect(isPackLimitError(new Error('pack too large: 99 > 10 bytes'))).toBe(true);
    expect(isPackLimitError({ name: 'PackLimitError', message: 'boom' })).toBe(true);
    expect(isPackLimitError(new Error('not found'))).toBe(false);
  });

  it('detects cross-repo pulls', () => {
    expect(isCrossRepoPull({})).toBe(false);
    expect(isCrossRepoPull({ head_repository_id: 'r2' })).toBe(true);
    expect(isCrossRepoPull({ head_full_name: 'bob/demo' })).toBe(true);
  });

  it('serves thread reads and rejects bad numbers', async () => {
    const { db } = createFillFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, '/repos/alice/demo/pulls/nope/threads')).status).toBe(404);
    const listed = await callWorker(env, '/repos/alice/demo/pulls/1/threads');
    expect(listed.status).toBe(200);
    expect((await listed.json()) as unknown).toMatchObject({ threads: [] });
    expect((await callWorker(env, '/user/repos/alice/demo/pulls/1/threads', postJson('/x', { path: '', body: '' }))).status).toBeDefined();
  });

  it('rejects discussions without titles and bad numbers', async () => {
    const { db } = createFillFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, '/repos/alice/demo/discussions/nope')).status).toBe(400);
    const created = await callWorker(env, '/user/repos/alice/demo/discussions', postJson('/x', { title: '' }));
    expect(created.status).toBe(400);
  });
});
