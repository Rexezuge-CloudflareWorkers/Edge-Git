import { describe, expect, it, vi, beforeEach } from 'vitest';

// FetchHandler value-imports PackLimitError from git-service barrel (dofs ->
// cloudflare:*). Stub it like fetch-handler-hardening does.
vi.mock('@edge-git/git-service', () => {
  class PackLimitError extends Error {}
  return { PackLimitError };
});

import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { PktLine } from '@edge-git/git-protocol';
import { FetchHandler } from '@edge-git/background/FetchHandler';
import { publishLiveUpdate, publishCheckUpdate, recordAndNotify } from '@/workers/routes/SocialEmit';
import { triggerRequiredChecks } from '@/workers/routes/TriggerChecks';
import { resetRateLimitForTests } from '@/middleware/rateLimit';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

beforeEach(() => {
  resetRateLimitForTests();
});

// --- Fake D1 ---------------------------------------------------------------
// Copied from route-fill-hardening pattern + branch/snippet/check extensions.
function createThinFakeDb() {
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
    branchRules: [] as Array<Record<string, unknown>>,
    checks: [] as Array<Record<string, unknown>>,
    releases: [] as Array<Record<string, unknown>>,
    releaseAssets: [] as Array<Record<string, unknown>>,
    snippets: [] as Array<Record<string, unknown>>,
    snippetFiles: [] as Array<Record<string, unknown>>,
    security: [] as Array<Record<string, unknown>>,
    tokens: [] as Array<Record<string, unknown>>,
    tokenGrants: [] as Array<Record<string, unknown>>,
  };

  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    const P = (i: number): string => String(params[i] ?? '');
    return {
      first<T>(): Promise<T | null> {
        // --- branch protection ---
        if (q.includes('FROM branch_protection_rules WHERE repository_id = ? AND pattern = ?')) {
          const row = state.branchRules.find((r) => r.repository_id === params[0] && r.pattern === params[1]) ?? null;
          return Promise.resolve(row as T | null);
        }
        if (q.includes('FROM branch_protection_rules WHERE id = ?')) {
          const row = state.branchRules.find((r) => r.id === params[0]) ?? null;
          return Promise.resolve(row as T | null);
        }
        if (q.includes('COUNT(*) AS n FROM branch_protection_rules')) {
          return Promise.resolve({ n: state.branchRules.filter((r) => r.repository_id === params[0]).length } as unknown as T);
        }
        // --- checks ---
        if (q.includes('FROM check_runs WHERE repository_id = ? AND head_sha = ? AND context = ?')) {
          const row =
            state.checks.find((c) => c.repository_id === params[0] && c.head_sha === P(1).toLowerCase() && String(c.context).toLowerCase() === P(2).toLowerCase()) ??
            null;
          return Promise.resolve(row as T | null);
        }
        if (q.includes('FROM check_runs WHERE id = ? AND repository_id = ?')) {
          const row = state.checks.find((c) => c.id === params[0] && c.repository_id === params[1]) ?? null;
          return Promise.resolve(row as T | null);
        }
        if (q.includes('COUNT(*) AS n FROM check_runs')) {
          const n = state.checks.filter((c) => c.repository_id === params[0] && (params.length < 2 || c.head_sha === P(1).toLowerCase())).length;
          return Promise.resolve({ n } as unknown as T);
        }
        // --- snippets ---
        if (q.includes('FROM snippets WHERE id = ?')) {
          return Promise.resolve((state.snippets.find((s) => s.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('COUNT(*) AS count FROM snippets')) {
          return Promise.resolve({ count: state.snippets.filter((s) => String(s.owner_email).toLowerCase() === P(0).toLowerCase()).length } as unknown as T);
        }
        if (q.includes('FROM users WHERE lower(email)')) {
          return Promise.resolve((state.users.find((u) => String(u.email).toLowerCase() === P(0).toLowerCase()) ?? null) as T | null);
        }
        if (q.includes('FROM users WHERE lower(username)')) {
          return Promise.resolve((state.users.find((u) => String(u.username ?? '').toLowerCase() === P(0).toLowerCase()) ?? null) as T | null);
        }
        if (q.includes('FROM users WHERE email = ?')) {
          return Promise.resolve((state.users.find((u) => u.email === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM namespaces WHERE username_ci = ?')) {
          return Promise.resolve((state.namespaces.find((n) => n.username_ci === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE lower(owner)')) {
          return Promise.resolve(
            (state.repos.find((r) => String(r.owner).toLowerCase() === P(0).toLowerCase() && String(r.name).toLowerCase() === P(1).toLowerCase()) ?? null) as T | null,
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
            (state.orgMembers.find((m) => m.org_id === params[0] && String(m.user_email).toLowerCase() === P(1).toLowerCase()) ?? null) as T | null,
          );
        }
        if (q.includes('COUNT(*) AS n FROM organization_members')) {
          return Promise.resolve({ n: state.orgMembers.filter((m) => m.org_id === params[0] && m.role === 'owner').length } as unknown as T);
        }
        if (q.includes('FROM teams WHERE org_id = ? AND slug_ci = ?')) {
          return Promise.resolve((state.teams.find((t) => t.org_id === params[0] && String(t.slug_ci).toLowerCase() === P(1).toLowerCase()) ?? null) as T | null);
        }
        if (q.includes('FROM teams WHERE id = ?')) {
          return Promise.resolve((state.teams.find((t) => t.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('COUNT(*) AS n FROM teams')) {
          return Promise.resolve({ n: state.teams.filter((t) => t.org_id === params[0]).length } as unknown as T);
        }
        if (q.includes('FROM team_members WHERE team_id = ? AND')) {
          return Promise.resolve(
            (state.teamMembers.find((m) => m.team_id === params[0] && String(m.user_email).toLowerCase() === P(1).toLowerCase()) ?? null) as T | null,
          );
        }
        if (q.includes("COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'admin'")) {
          return Promise.resolve({ n: state.teamMembers.filter((m) => m.team_id === params[0] && m.role === 'admin').length } as unknown as T);
        }
        if (q.includes('FROM team_repo_grants WHERE team_id = ? AND repo_id = ?')) {
          return Promise.resolve((state.teamGrants.find((g) => g.team_id === params[0] && g.repo_id === params[1]) ?? null) as T | null);
        }
        if (q.includes('COUNT(*) AS n FROM team_repo_grants')) {
          return Promise.resolve({ n: state.teamGrants.filter((g) => g.team_id === params[0]).length } as unknown as T);
        }
        if (q.includes('FROM repo_collaborators WHERE repo_id = ? AND')) {
          return Promise.resolve(
            (state.collaborators.find((c) => c.repo_id === params[0] && String(c.user_email).toLowerCase() === P(1).toLowerCase()) ?? null) as T | null,
          );
        }
        if (q.includes('FROM releases WHERE repository_id = ? AND tag_name = ?')) {
          return Promise.resolve((state.releases.find((r) => r.repository_id === params[0] && r.tag_name === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM releases WHERE id = ? AND repository_id = ?')) {
          return Promise.resolve((state.releases.find((r) => r.id === params[0] && r.repository_id === params[1]) ?? null) as T | null);
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
          return Promise.resolve((state.tokens.find((t) => t.token_hash === params[0] && (t.expires_at as number) > (params[1] as number)) ?? null) as T | null);
        }
        if (q.includes('COUNT(*)')) return Promise.resolve({ n: 0, count: 0 } as unknown as T);
        if (q.includes('COALESCE(MAX(number)')) return Promise.resolve({ max_n: 0, next_number: 1 } as unknown as T);
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM branch_protection_rules WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.branchRules.filter((r) => r.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM check_runs WHERE repository_id = ? AND head_sha = ?')) {
          return Promise.resolve({ results: state.checks.filter((c) => c.repository_id === params[0] && c.head_sha === P(1).toLowerCase()) as T[] });
        }
        if (q.includes('FROM snippets WHERE owner_email = ?')) {
          const onlyPublic = q.includes("visibility = 'public'");
          let rows = state.snippets.filter((s) => String(s.owner_email).toLowerCase() === P(0).toLowerCase());
          if (onlyPublic) rows = rows.filter((s) => s.visibility === 'public');
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes("FROM snippets WHERE visibility = 'public'")) {
          const limit = typeof params[params.length - 1] === 'number' ? (params[params.length - 1] as number) : 50;
          return Promise.resolve({ results: state.snippets.filter((s) => s.visibility === 'public').slice(0, limit) as T[] });
        }
        if (q.includes('FROM snippet_files WHERE snippet_id = ?')) {
          return Promise.resolve({ results: state.snippetFiles.filter((f) => f.snippet_id === params[0]) as T[] });
        }
        if (q.includes('FROM repositories WHERE') && q.includes('owner_email')) {
          return Promise.resolve({ results: state.repos.filter((r) => String(r.owner_email).toLowerCase() === P(0).toLowerCase()) as T[] });
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
          return Promise.resolve({ results: state.orgMembers.filter((m) => String(m.user_email).toLowerCase() === P(0).toLowerCase()) as T[] });
        }
        if (q.includes('FROM teams WHERE org_id = ? ORDER BY')) {
          return Promise.resolve({ results: state.teams.filter((t) => t.org_id === params[0]) as T[] });
        }
        if (q.includes('FROM team_members WHERE team_id = ? ORDER BY')) {
          return Promise.resolve({ results: state.teamMembers.filter((m) => m.team_id === params[0]) as T[] });
        }
        if (q.includes('FROM team_members WHERE lower(user_email)')) {
          return Promise.resolve({ results: state.teamMembers.filter((m) => String(m.user_email).toLowerCase() === P(0).toLowerCase()) as T[] });
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
        if (q.includes('FROM releases WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.releases.filter((r) => r.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM release_assets WHERE')) {
          return Promise.resolve({ results: state.releaseAssets.filter((a) => a.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM user_access_tokens WHERE')) {
          return Promise.resolve({ results: state.tokens.filter((t) => String(t.user_email).toLowerCase() === P(0).toLowerCase()) as T[] });
        }
        return Promise.resolve({ results: [] as T[] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO branch_protection_rules')) {
          state.branchRules.push({
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
        if (q.startsWith('INSERT INTO check_runs')) {
          state.checks.push({
            id: params[0],
            repository_id: params[1],
            head_sha: String(params[2]).toLowerCase(),
            context: params[3],
            status: 'queued',
            conclusion: null,
            details_url: null,
            output_title: null,
            output_summary: null,
            creator_email: params[4] ?? ALICE,
            created_at: params[5] ?? 1,
            updated_at: params[5] ?? 1,
            completed_at: null,
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE check_runs SET status = ?')) {
          const row = state.checks.find((c) => c.id === params[7] && c.repository_id === params[8]);
          if (row) {
            row.status = params[0];
            row.conclusion = params[1];
            row.details_url = params[2];
            row.output_title = params[3];
            row.output_summary = params[4];
            row.updated_at = params[5];
            row.completed_at = params[6];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO snippets')) {
          state.snippets.push({ id: params[0], owner_email: String(params[1]).toLowerCase(), title: params[2], visibility: params[3], created_at: params[4], updated_at: params[5] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO snippet_files')) {
          state.snippetFiles.push({ id: params[0], snippet_id: params[1], filename: params[2], body: params[3], created_at: params[4] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE snippets SET')) {
          const id = params[params.length - 1];
          const row = state.snippets.find((s) => s.id === id);
          if (row) {
            if (q.includes('title = ?') && q.includes('visibility = ?')) {
              row.title = params[0];
              row.visibility = params[1];
            } else if (q.includes('title = ?')) {
              row.title = params[0];
            } else if (q.includes('visibility = ?')) {
              row.visibility = params[0];
            }
            row.updated_at = params[params.length - 2];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM snippet_files WHERE snippet_id = ?')) {
          state.snippetFiles = state.snippetFiles.filter((f) => f.snippet_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM snippets WHERE id = ?')) {
          state.snippets = state.snippets.filter((s) => s.id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO users')) {
          if (!state.users.some((u) => u.email === params[0])) state.users.push({ email: params[0], created_at: params[1] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE users SET')) {
          const row = state.users.find((u) => String(u.email).toLowerCase() === String(params[params.length - 1]).toLowerCase());
          if (row && !row.username) row.username = params[0];
          if (row) row.username = params[0] ?? row.username;
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO namespaces') || q.startsWith('INSERT OR IGNORE INTO namespaces')) {
          if (!state.namespaces.some((n) => n.username_ci === params[0]))
            state.namespaces.push({ username_ci: params[0], kind: params[1], user_email: params[2] ?? null, org_id: params[3] ?? null });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO teams')) {
          state.teams.push({ id: params[0], org_id: params[1], slug: params[2], slug_ci: params[3], name: params[4], description: params[5], created_by: params[6], created_at: params[7], updated_at: params[8] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO team_repo_grants')) {
          const existing = state.teamGrants.find((g) => g.team_id === params[0] && g.repo_id === params[1]);
          if (existing) existing.role = params[2];
          else state.teamGrants.push({ team_id: params[0], repo_id: params[1], role: params[2], granted_by: params[3], created_at: params[4] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO releases')) {
          state.releases.push({ id: params[0], repository_id: params[1], tag_name: params[2], name: params[3], body: params[4], is_draft: params[5], is_prerelease: params[6], created_by: params[7], created_at: params[8], published_at: params[9] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE releases SET')) {
          const row = state.releases.find((r) => r.id === params[params.length - 1]);
          if (row) {
            // updateRelease DAO sends dynamic patch; handle is_draft + published_at generically
            if (q.includes('is_draft')) {
              // find is_draft param position: first boolean-ish
              const draftVal = params[0];
              row.is_draft = draftVal ? 1 : 0;
              if (params.length > 2) row.published_at = params[1] ?? row.published_at;
            }
            if (q.includes('name = ?')) row.name = params[0];
          }
          // Fallback: reload via getByTag will read updated row; ensure published path works
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // Generic release update from DAO: UPDATE releases SET name=?, body=?, is_draft=?, ... WHERE id=?
        // The above generic handles is_draft; for publish we need is_draft=0 + published_at set.
        // Patch: if query updates is_draft to false, force published_at non-null.
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

function createDoStub(opts: { tags?: Array<{ name: string }>; publishCounter?: { count: number } } = {}) {
  const tags = opts.tags ?? [];
  const publishCounter = opts.publishCounter;
  return {
    setFullName: () => Promise.resolve(),
    ensureRepoInitialized: () => Promise.resolve(),
    deleteRepo: () => Promise.resolve(),
    listRefs: () => Promise.resolve({ refs: [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }], symbolicHead: 'refs/heads/main' }),
    getBranches: () => Promise.resolve({ branches: ['main'], currentBranch: 'main' }),
    getTree: () => Promise.resolve([]),
    getBlob: () => Promise.resolve(null),
    getCommits: () => Promise.resolve([]),
    getTags: () => Promise.resolve(tags),
    getOverview: () => Promise.resolve({ branches: ['main'], currentBranch: 'main', resolvedRef: 'a'.repeat(40), tags: [], tree: [], commits: [], readme: null }),
    getBlame: () => Promise.resolve([]),
    resolveRef: () => Promise.resolve('a'.repeat(40)),
    createBranch: () => Promise.resolve({ ok: true, ref: 'refs/heads/x', oid: 'a'.repeat(40) }),
    deleteBranchRef: () => Promise.resolve({ ok: true }),
    setDefaultBranch: () => Promise.resolve({ ok: true }),
    commitFile: () => Promise.resolve({ ok: true, commitOid: 'c'.repeat(40), created: true }),
    exportPack: () => Promise.resolve({ oids: ['a'.repeat(40)], pack: new Uint8Array([1, 2, 3]) }),
    importPack: () => Promise.resolve({ importedRefs: [] }),
    receivePack: () => Promise.resolve(new Response('ok')),
    fetch: () => Promise.resolve(new Response('PACK', { status: 200 })),
    mergePull: () => Promise.resolve({ ok: true }),
    getReleaseAsset: () => Promise.resolve(null),
    storeReleaseAsset: () => Promise.resolve({ ok: true }),
    deleteReleaseAsset: () => Promise.resolve({ ok: true }),
    deleteReleaseAssets: () => Promise.resolve({ ok: true }),
    enqueueChecks: () => Promise.resolve({ ok: true }),
    publish: (..._args: unknown[]) => {
      if (publishCounter) publishCounter.count += 1;
      return Promise.resolve();
    },
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

function createAnonEnv(db: D1Queryable, overrides: Record<string, unknown> = {}) {
  const stub = createDoStub();
  return {
    DB: db,
    REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    CRON_TASKS: { get: () => stub, idFromName: (n: string) => n },
    CHECK_RUNNER: { get: () => stub, idFromName: (n: string) => n },
    REALTIME: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
    ENVIRONMENT: 'production',
    ...overrides,
  };
}

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function callWorker(env: unknown, path: string, init?: RequestInit): Promise<Response> {
  const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
  return worker.onRequest(new Request(`https://git.example.com${path}`, init), env, CTX);
}

function postJson(path: string, body: unknown): RequestInit {
  return { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) };
}

function receivePackBody(oldOid: string, newOid: string, ref: string): Uint8Array {
  const cmd = PktLine.encode(`${oldOid} ${newOid} ${ref}\0report-status\n`);
  return PktLine.mergeLines([cmd, PktLine.encodeFlush(), new TextEncoder().encode('PACK')]);
}

async function mintPat(env: unknown): Promise<string> {
  const res = await callWorker(env, '/user/tokens', postJson('/x', { name: 'git' }));
  expect(res.status).toBe(201);
  const body = (await res.json()) as { token: string };
  expect(body.token.length).toBeGreaterThan(10);
  return body.token;
}

// --- GitRoutes thin edges --------------------------------------------------
describe('GitRoutes thin edges', () => {
  it('rejects invalid service with 400', async () => {
    const { db } = createThinFakeDb();
    const res = await callWorker(createEnv(db), '/alice/demo/info/refs?service=git-nope');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Invalid service');
  });

  it('rejects malformed owner with 401 oracle guard', async () => {
    const { db } = createThinFakeDb();
    const res = await callWorker(createEnv(db), '/bad%20owner/demo/info/refs?service=git-upload-pack');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Basic');
  });

  it('rejects malformed repo on push with 401', async () => {
    const { db } = createThinFakeDb();
    const res = await callWorker(createEnv(db), '/alice/bad%20repo/git-receive-pack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-git-receive-pack-request' },
      body: new Uint8Array([1]) as unknown as BodyInit,
    });
    expect(res.status).toBe(401);
  });

  it('returns 413 when fetch body exceeds limit via Content-Length', async () => {
    const { db } = createThinFakeDb();
    const res = await callWorker(createAnonEnv(db), '/alice/demo/git-upload-pack', {
      method: 'POST',
      headers: { 'Content-Length': '99999999', 'Content-Type': 'application/x-git-upload-pack-request' },
      body: new Uint8Array([1, 2, 3]) as unknown as BodyInit,
    });
    expect(res.status).toBe(413);
    expect(await res.text()).toContain('too large');
  });

  it('returns 413 when push body exceeds limit via Content-Length', async () => {
    const { db } = createThinFakeDb();
    const env = createEnv(db);
    const token = await mintPat(env);
    const res = await callWorker(env, '/alice/demo/git-receive-pack', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Length': '99999999', 'Content-Type': 'application/x-git-receive-pack-request' },
      body: new Uint8Array([1]) as unknown as BodyInit,
    });
    expect(res.status).toBe(413);
    expect(await res.text()).toContain('pack too large');
  });

  it('fails closed with 503 when push protections D1 throws', async () => {
    const { db, state } = createThinFakeDb();
    void state;
    const base = db;
    const throwingDb = {
      prepare: (query: string) => {
        if (query.includes('branch_protection_rules')) {
          return {
            bind: () => ({
              first: () => Promise.reject(new Error('D1 down')),
              all: () => Promise.reject(new Error('D1 down')),
              run: () => Promise.reject(new Error('D1 down')),
            }),
          };
        }
        return (base as { prepare: (q: string) => unknown }).prepare(query) as never;
      },
    } as unknown as D1Queryable;
    const env = createEnv(throwingDb);
    // Mint against base DB state? mint uses throwingDb too but tokens table unaffected.
    const token = await mintPat(env);
    const body = receivePackBody('a'.repeat(40), 'b'.repeat(40), 'refs/heads/main');
    const res = await callWorker(env, '/alice/demo/git-receive-pack', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-git-receive-pack-request' },
      body: body as unknown as BodyInit,
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('push protections unavailable');
  });

  it('rejects unparseable push body with 400 typed error', async () => {
    const { db } = createThinFakeDb();
    const env = createEnv(db);
    const token = await mintPat(env);
    const res = await callWorker(env, '/alice/demo/git-receive-pack', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-git-receive-pack-request' },
      body: new Uint8Array([1, 2, 3]) as unknown as BodyInit,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('invalid push request');
  });
});

// --- Release draft hidden + publish missing tag -----------------------------
describe('ReleaseRoutes thin edges', () => {
  it('hides drafts from public and non-writers, publishes require tag', async () => {
    const { db, state } = createThinFakeDb();
    const env = createEnv(db);
    const created = await callWorker(env, '/user/repos/alice/demo/releases', postJson('/x', { tagName: 'v1', isDraft: true }));
    expect(created.status).toBe(201);
    expect(state.releases).toHaveLength(1);

    const publicList = await callWorker(createAnonEnv(db), '/repos/alice/demo/releases');
    expect(publicList.status).toBe(200);
    expect(((await publicList.json()) as { releases: unknown[] }).releases).toHaveLength(0);

    const publicGet = await callWorker(createAnonEnv(db), '/repos/alice/demo/releases/v1');
    expect(publicGet.status).toBe(404);

    const ownerGet = await callWorker(env, '/user/repos/alice/demo/releases/v1');
    expect(ownerGet.status).toBe(200);

    const bobEnv = createEnv(db, { DEV_AUTH_EMAIL: BOB });
    const bobGet = await callWorker(bobEnv, '/user/repos/alice/demo/releases/v1');
    expect(bobGet.status).toBe(404);

    // Publish without git tag -> 400 (DO has no tags)
    const publish = await callWorker(env, '/user/repos/alice/demo/releases/v1', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ isDraft: false }),
    });
    expect(publish.status).toBe(400);
    expect(((await publish.json()) as { error: string }).error).toContain('git tag');
  });

  it('rejects non-draft creation without git tag', async () => {
    const { db } = createThinFakeDb();
    const res = await callWorker(createEnv(db), '/user/repos/alice/demo/releases', postJson('/x', { tagName: 'v9', isDraft: false }));
    expect(res.status).toBe(400);
  });
});

// --- Snippet owner-only ------------------------------------------------------
describe('SnippetRoutes thin edges', () => {
  it('enforces owner-only update/delete/get', async () => {
    const { db } = createThinFakeDb();
    const env = createEnv(db);
    const createdRes = await callWorker(env, '/user/snippets', postJson('/x', { title: 's', visibility: 'secret', files: [{ filename: 'a.txt', body: 'hi' }] }));
    expect(createdRes.status).toBe(201);
    const created = (await createdRes.json()) as { snippet: { id: string } };
    const id = created.snippet.id;
    expect(id).toBeTruthy();

    const bobEnv = createEnv(db, { DEV_AUTH_EMAIL: BOB });
    const bobPatch = await callWorker(bobEnv, `/user/snippets/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: 'hax' }),
    });
    expect(bobPatch.status).toBe(403);

    const bobDelete = await callWorker(bobEnv, `/user/snippets/${id}`, { method: 'DELETE' });
    expect(bobDelete.status).toBe(403);

    const bobGet = await callWorker(bobEnv, `/user/snippets/${id}`);
    expect(bobGet.status).toBe(404);

    const anonGet = await callWorker(createAnonEnv(db), `/snippets/${id}`);
    expect(anonGet.status).toBe(404);

    // Owner can still read/update
    const ownerGet = await callWorker(env, `/user/snippets/${id}`);
    expect(ownerGet.status).toBe(200);
    const ownerPatch = await callWorker(env, `/user/snippets/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: 'renamed' }),
    });
    expect(ownerPatch.status).toBe(200);
  });
});

// --- Check report invalid ----------------------------------------------------
describe('CheckRoutes thin edges', () => {
  it('rejects invalid sha and missing context', async () => {
    const { db } = createThinFakeDb();
    const env = createEnv(db);
    const badSha = await callWorker(env, '/user/repos/alice/demo/checks', postJson('/x', { headSha: 'short', context: 'ci' }));
    expect(badSha.status).toBe(400);
    const missingCtx = await callWorker(env, '/user/repos/alice/demo/checks', postJson('/x', { headSha: 'a'.repeat(40) }));
    expect(missingCtx.status).toBe(400);
  });

  it('reports a valid check run', async () => {
    const { db, state } = createThinFakeDb();
    const env = createEnv(db);
    const res = await callWorker(env, '/user/repos/alice/demo/checks', postJson('/x', { headSha: 'a'.repeat(40), context: 'ci' }));
    expect(res.status).toBe(201);
    expect(state.checks).toHaveLength(1);
  });

  it('requires status on runner update', async () => {
    const { db } = createThinFakeDb();
    const res = await callWorker(createEnv(db), '/user/repos/alice/demo/checks/c1', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ conclusion: 'success' }),
    });
    expect(res.status).toBe(400);
  });
});

// --- Team member guards ------------------------------------------------------
describe('TeamRoutes thin edges', () => {
  it('blocks non-members from listing and managing teams', async () => {
    const { db } = createThinFakeDb();
    const bobEnv = createEnv(db, { DEV_AUTH_EMAIL: BOB });
    const list = await callWorker(bobEnv, '/user/orgs/acme/teams');
    expect([403, 404]).toContain(list.status);

    const get = await callWorker(bobEnv, '/user/orgs/acme/teams/dev');
    expect([403, 404]).toContain(get.status);

    const add = await callWorker(bobEnv, '/user/orgs/acme/teams/dev/members', postJson('/x', { email: BOB, role: 'member' }));
    expect([403, 404]).toContain(add.status);

    const members = await callWorker(bobEnv, '/user/orgs/acme/teams/dev/members');
    expect([403, 404]).toContain(members.status);
  });

  it('lets org members list teams', async () => {
    const { db } = createThinFakeDb();
    const res = await callWorker(createEnv(db), '/user/orgs/acme/teams');
    expect(res.status).toBe(200);
  });
});

// --- SocialEmit disabled -----------------------------------------------------
describe('SocialEmit thin edges', () => {
  it('no-ops live and check updates when REALTIME_ENABLED!=true', async () => {
    const { db } = createThinFakeDb();
    const counter = { count: 0 };
    const stub = createDoStub({ publishCounter: counter });
    const env = {
      DB: db,
      REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
      CHECK_RUNNER: { get: () => stub, idFromName: (n: string) => n },
      REALTIME: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
      ENVIRONMENT: 'development',
      DEV_AUTH_EMAIL: ALICE,
      // REALTIME_ENABLED absent -> disabled
    };
    await expect(publishLiveUpdate(env as never, { fullName: 'alice/demo', channel: 'activity', type: 'push', actorEmail: ALICE, title: 'hi' })).resolves.toBeUndefined();
    expect(counter.count).toBe(0);
    await expect(
      publishCheckUpdate(env as never, { fullName: 'alice/demo', headSha: 'a'.repeat(40), context: 'ci', status: 'queued', actorEmail: ALICE }),
    ).resolves.toBeUndefined();
    expect(counter.count).toBe(0);

    const explicitOff = { ...env, REALTIME_ENABLED: 'false' };
    await expect(publishLiveUpdate(explicitOff as never, { fullName: 'alice/demo', channel: 'activity', type: 'push', actorEmail: ALICE, title: 'hi' })).resolves.toBeUndefined();
    expect(counter.count).toBe(0);
  });

  it('recordAndNotify never throws', async () => {
    const { db } = createThinFakeDb();
    const env = createEnv(db);
    await expect(
      recordAndNotify(env as never, { repositoryId: 'r-demo', fullName: 'alice/demo', actorEmail: ALICE, type: 'push', title: 'Pushed' }),
    ).resolves.toBeUndefined();
  });
});

// --- TriggerChecks thin edges ------------------------------------------------
describe('TriggerChecks thin edges', () => {
  it('skips invalid and zero shas', async () => {
    const { db } = createThinFakeDb();
    const env = createEnv(db);
    await expect(triggerRequiredChecks(env as never, { repositoryId: 'r-demo', fullName: 'alice/demo', branch: 'main', headSha: 'bad', actorEmail: ALICE })).resolves.toEqual({ triggered: [] });
    await expect(
      triggerRequiredChecks(env as never, { repositoryId: 'r-demo', fullName: 'alice/demo', branch: 'main', headSha: '0'.repeat(40), actorEmail: ALICE }),
    ).resolves.toEqual({ triggered: [] });
  });

  it('triggers required contexts when a protection rule matches', async () => {
    const { db, state } = createThinFakeDb();
    const env = createEnv(db);
    const ruleRes = await callWorker(env, '/user/repos/alice/demo/rules', postJson('/x', { pattern: 'main', requireStatusChecks: ['ci'] }));
    expect(ruleRes.status).toBe(201);
    expect(state.branchRules).toHaveLength(1);
    const out = await triggerRequiredChecks(env as never, {
      repositoryId: 'r-demo',
      fullName: 'alice/demo',
      branch: 'main',
      headSha: 'b'.repeat(40),
      actorEmail: ALICE,
    });
    expect(out.triggered).toEqual(['ci']);
    expect(state.checks.length).toBeGreaterThanOrEqual(1);
  });
});

// --- UserRoutes thin edges ---------------------------------------------------
describe('UserRoutes thin edges', () => {
  it('returns 404 for unknown profiles', async () => {
    const { db } = createThinFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, '/users/ghost-xyz')).status).toBe(404);
    expect((await callWorker(env, '/users/ghost-xyz/repos')).status).toBe(404);
    expect((await callWorker(env, '/users/ghost-xyz/orgs')).status).toBe(404);
  });

  it('serves user and org profiles with repo counts', async () => {
    const { db } = createThinFakeDb();
    const env = createEnv(db);
    const user = await callWorker(env, '/users/alice');
    expect(user.status).toBe(200);
    expect(((await user.json()) as { type: string }).type).toBe('user');

    const org = await callWorker(env, '/users/acme');
    expect(org.status).toBe(200);
    expect(((await org.json()) as { type: string }).type).toBe('org');

    const repos = await callWorker(env, '/users/alice/repos?limit=1');
    expect(repos.status).toBe(200);

    const orgsSelf = await callWorker(env, '/users/alice/orgs');
    expect(orgsSelf.status).toBe(200);
  });

  it('validates username rename', async () => {
    const { db } = createThinFakeDb();
    const env = createEnv(db);
    const missing = await callWorker(env, '/user/me/username', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({}) });
    expect(missing.status).toBe(400);
    const invalid = await callWorker(env, '/user/me/username', { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ username: 'bad name!' }) });
    expect(invalid.status).toBe(400);
  });
});

// --- FetchHandler thin edges -------------------------------------------------
function encodeCommand(command: string, args: string[]): Uint8Array {
  const lines = [PktLine.encode(`command=${command}\n`), PktLine.encodeDelim(), ...args.map((a) => PktLine.encode(`${a}\n`)), PktLine.encodeFlush()];
  return PktLine.mergeLines(lines);
}

function fakeGit(overrides: Record<string, unknown> = {}) {
  return {
    ensureFreshCache: vi.fn(),
    listRefs: vi.fn().mockResolvedValue({ refs: [], symbolicHead: null }),
    findCommonCommits: vi.fn().mockResolvedValue([]),
    resolveRef: vi.fn().mockImplementation((ref: string) => Promise.resolve(ref)),
    collectObjectsForPack: vi.fn().mockResolvedValue({ oids: [], shallow: [] }),
    packObjects: vi.fn().mockResolvedValue(new Uint8Array(0)),
    listTags: vi.fn().mockResolvedValue([]),
    peelTag: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as never;
}

const limits = { maxWants: 64, maxHaves: 512, maxObjects: 10, maxPackBytes: 1024 * 1024, maxFetchBodyBytes: 1024 * 1024 };

describe('FetchHandler thin edges', () => {
  it('rejects oversized bodies with 413', async () => {
    const git = fakeGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const res = await handler.uploadPack(new Uint8Array(11), { ...limits, maxFetchBodyBytes: 10 });
    expect(res.status).toBe(413);
  });

  it('rejects too many args with 400 before git I/O', async () => {
    const git = fakeGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const data = encodeCommand('ls-refs', Array.from({ length: 65 }, (_, i) => `arg-${i}`));
    const res = await handler.uploadPack(data, limits);
    expect(res.status).toBe(400);
    expect(git.listRefs).not.toHaveBeenCalled();
  });

  it('rejects unsupported commands with 400', async () => {
    const git = fakeGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const data = encodeCommand('nope', []);
    const res = await handler.uploadPack(data, limits);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('unsupported command');
  });
});
