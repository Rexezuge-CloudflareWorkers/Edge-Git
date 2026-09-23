import { describe, expect, it, beforeEach } from 'vitest';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { resetRateLimitForTests } from '@/middleware/rateLimit';

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

beforeEach(() => {
  resetRateLimitForTests();
});

// --- Fake D1 covering the 10 lowest route files ---------------------------
function createLowFakeDb() {
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
    projects: [] as Array<Record<string, unknown>>,
    projectColumns: [] as Array<Record<string, unknown>>,
    projectCards: [] as Array<Record<string, unknown>>,
    discussionCategories: [] as Array<Record<string, unknown>>,
    discussions: [] as Array<Record<string, unknown>>,
    discussionComments: [] as Array<Record<string, unknown>>,
    wikiPages: [] as Array<Record<string, unknown>>,
    wikiRevisions: [] as Array<Record<string, unknown>>,
    mirrors: [] as Array<Record<string, unknown>>,
    stars: [] as Array<Record<string, unknown>>,
    watches: [] as Array<Record<string, unknown>>,
    notifications: [] as Array<Record<string, unknown>>,
    events: [] as Array<Record<string, unknown>>,
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
    threadComments: [] as Array<Record<string, unknown>>,
    releases: [] as Array<Record<string, unknown>>,
    releaseAssets: [] as Array<Record<string, unknown>>,
    collaborators: [] as Array<Record<string, unknown>>,
  };

  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    const P = (i: number): string => String(params[i] ?? '');
    const Pl = (i: number): string => P(i).toLowerCase();
    return {
      first<T>(): Promise<T | null> {
        // FTS tables -> no candidates (service returns empty, still 200)
        if (
          q.includes('FROM repo_fts') ||
          q.includes('FROM issue_fts') ||
          q.includes('FROM pull_fts') ||
          q.includes('FROM code_fts') ||
          q.includes('FROM discussion_fts') ||
          q.includes('FROM snippet_fts')
        )
          return Promise.resolve(null);
        // users
        if (q.includes('FROM users WHERE lower(email)')) {
          return Promise.resolve((state.users.find((u) => String(u.email).toLowerCase() === Pl(0)) ?? null) as T | null);
        }
        if (q.includes('FROM users WHERE lower(username)')) {
          return Promise.resolve((state.users.find((u) => String(u.username ?? '').toLowerCase() === Pl(0)) ?? null) as T | null);
        }
        if (q.includes('FROM users WHERE email = ?')) {
          return Promise.resolve((state.users.find((u) => u.email === params[0]) ?? null) as T | null);
        }
        // namespaces
        if (q.includes('FROM namespaces WHERE username_ci = ?')) {
          return Promise.resolve((state.namespaces.find((n) => n.username_ci === params[0]) ?? null) as T | null);
        }
        // repositories
        if (q.includes('FROM repositories WHERE owner_ci = ? AND name_ci = ?')) {
          return Promise.resolve(
            (state.repos.find(
              (r) => String(r.owner_ci ?? r.owner).toLowerCase() === Pl(0) && String(r.name_ci ?? r.name).toLowerCase() === Pl(1),
            ) ?? null) as T | null,
          );
        }
        if (q.includes('FROM repositories WHERE id = ?')) {
          return Promise.resolve((state.repos.find((r) => r.id === params[0]) ?? null) as T | null);
        }
        // organizations (members first to avoid substring collision)
        if (q.includes('FROM organization_members WHERE org_id = ? AND')) {
          return Promise.resolve(
            (state.orgMembers.find((m) => m.org_id === params[0] && String(m.user_email).toLowerCase() === Pl(1)) ?? null) as T | null,
          );
        }
        if (q.includes('COUNT(*) AS n FROM organization_members')) {
          return Promise.resolve({
            n: state.orgMembers.filter((m) => m.org_id === params[0] && m.role === 'owner').length,
          } as unknown as T);
        }
        if (q.includes('FROM organizations WHERE username_ci = ?')) {
          return Promise.resolve((state.organizations.find((o) => o.username_ci === params[0]) ?? null) as T | null);
        }
        if (q.includes('FROM organizations WHERE id = ?')) {
          return Promise.resolve((state.organizations.find((o) => o.id === params[0]) ?? null) as T | null);
        }
        // collaborators
        if (q.includes('FROM repo_collaborators WHERE repo_id = ? AND')) {
          return Promise.resolve(
            (state.collaborators.find((c) => c.repo_id === params[0] && String(c.user_email).toLowerCase() === Pl(1)) ?? null) as T | null,
          );
        }
        // projects (cards/columns before projects)
        if (q.includes('FROM project_cards WHERE id = ? AND project_id = ?')) {
          return Promise.resolve((state.projectCards.find((c) => c.id === params[0] && c.project_id === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM project_columns WHERE id = ? AND project_id = ?')) {
          return Promise.resolve((state.projectColumns.find((c) => c.id === params[0] && c.project_id === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM projects WHERE repository_id = ? AND number = ?')) {
          return Promise.resolve((state.projects.find((p) => p.repository_id === params[0] && p.number === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM projects WHERE id = ? AND repository_id = ?')) {
          return Promise.resolve((state.projects.find((p) => p.id === params[0] && p.repository_id === params[1]) ?? null) as T | null);
        }
        if (q.includes('COALESCE(MAX(number)') && q.includes('FROM projects')) {
          const max = state.projects
            .filter((p) => p.repository_id === params[0])
            .reduce((m, p) => Math.max(m, (p.number as number) ?? 0), 0);
          return Promise.resolve({ next_number: max + 1, max_n: max } as unknown as T);
        }
        if (q.includes('COUNT(*) AS count FROM projects')) {
          return Promise.resolve({ count: state.projects.filter((p) => p.repository_id === params[0]).length } as unknown as T);
        }
        if (q.includes('COUNT(*) AS count FROM project_cards WHERE column_id = ?')) {
          return Promise.resolve({
            count: state.projectCards.filter((c) => c.column_id === params[0] && c.archived === 0).length,
          } as unknown as T);
        }
        // discussions (comments/categories/threads before discussions)
        if (q.includes('FROM discussion_comments WHERE id = ? AND discussion_id = ?')) {
          return Promise.resolve(
            (state.discussionComments.find((c) => c.id === params[0] && c.discussion_id === params[1]) ?? null) as T | null,
          );
        }
        if (q.includes('FROM discussion_categories WHERE repository_id = ? AND slug = ?')) {
          return Promise.resolve(
            (state.discussionCategories.find((c) => c.repository_id === params[0] && c.slug === params[1]) ?? null) as T | null,
          );
        }
        if (q.includes('FROM discussion_categories WHERE id = ? AND repository_id = ?')) {
          return Promise.resolve(
            (state.discussionCategories.find((c) => c.id === params[0] && c.repository_id === params[1]) ?? null) as T | null,
          );
        }
        if (q.includes('FROM discussions WHERE repository_id = ? AND number = ?')) {
          return Promise.resolve(
            (state.discussions.find((d) => d.repository_id === params[0] && d.number === params[1]) ?? null) as T | null,
          );
        }
        if (q.includes('FROM discussions WHERE id = ?')) {
          return Promise.resolve((state.discussions.find((d) => d.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('COALESCE(MAX(number)') && q.includes('FROM discussions')) {
          const max = state.discussions
            .filter((d) => d.repository_id === params[0])
            .reduce((m, d) => Math.max(m, (d.number as number) ?? 0), 0);
          return Promise.resolve({ next_number: max + 1, max_n: max } as unknown as T);
        }
        if (q.includes('COUNT(*) AS count FROM discussions')) {
          return Promise.resolve({ count: state.discussions.filter((d) => d.repository_id === params[0]).length } as unknown as T);
        }
        // wiki (revisions before pages)
        if (q.includes('FROM wiki_pages WHERE repository_id = ? AND slug = ?')) {
          return Promise.resolve((state.wikiPages.find((w) => w.repository_id === params[0] && w.slug === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM wiki_pages WHERE id = ? AND repository_id = ?')) {
          return Promise.resolve((state.wikiPages.find((w) => w.id === params[0] && w.repository_id === params[1]) ?? null) as T | null);
        }
        if (q.includes('COUNT(*) AS count FROM wiki_pages')) {
          return Promise.resolve({ count: state.wikiPages.filter((w) => w.repository_id === params[0]).length } as unknown as T);
        }
        // mirrors
        if (q.includes('FROM repo_mirrors WHERE repository_id = ?')) {
          return Promise.resolve((state.mirrors.find((m) => m.repository_id === params[0]) ?? null) as T | null);
        }
        // stars / watches
        if (q.includes('FROM repo_stars WHERE repo_id = ? AND user_email = ?')) {
          const row = state.stars.find((s) => s.repo_id === params[0] && String(s.user_email).toLowerCase() === Pl(1)) ?? null;
          return Promise.resolve(row as T | null);
        }
        if (q.includes('COUNT(*) AS n FROM repo_stars')) {
          return Promise.resolve({ n: state.stars.filter((s) => s.repo_id === params[0]).length } as unknown as T);
        }
        if (q.includes('FROM repo_watches WHERE repo_id = ? AND user_email = ?')) {
          const row = state.watches.find((s) => s.repo_id === params[0] && String(s.user_email).toLowerCase() === Pl(1)) ?? null;
          return Promise.resolve(row as T | null);
        }
        if (q.includes('COUNT(*) AS n FROM repo_watches')) {
          return Promise.resolve({ n: state.watches.filter((s) => s.repo_id === params[0]).length } as unknown as T);
        }
        // notifications
        if (q.includes('COUNT(*) AS n FROM notifications WHERE user_email = ? AND is_read = 0')) {
          return Promise.resolve({
            n: state.notifications.filter((n) => String(n.user_email).toLowerCase() === Pl(0) && n.is_read === 0).length,
          } as unknown as T);
        }
        // pulls / threads (thread tables before pulls)
        if (q.includes('FROM pull_review_threads WHERE pull_request_id = ? AND id = ?')) {
          return Promise.resolve((state.threads.find((t) => t.pull_request_id === params[0] && t.id === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM pull_requests WHERE repository_id = ? AND number = ?')) {
          return Promise.resolve((state.pulls.find((p) => p.repository_id === params[0] && p.number === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM pull_requests WHERE id = ?')) {
          return Promise.resolve((state.pulls.find((p) => p.id === params[0]) ?? null) as T | null);
        }
        if (q.includes('COALESCE(MAX(number)') && q.includes('FROM pull_requests')) {
          const max = state.pulls.filter((p) => p.repository_id === params[0]).reduce((m, p) => Math.max(m, (p.number as number) ?? 0), 0);
          return Promise.resolve({ max_n: max } as unknown as T);
        }
        // releases (assets before releases)
        if (q.includes('FROM release_assets WHERE id = ? AND release_id = ?')) {
          return Promise.resolve((state.releaseAssets.find((a) => a.id === params[0] && a.release_id === params[1]) ?? null) as T | null);
        }
        if (q.includes('FROM release_assets WHERE release_id = ? AND name = ?')) {
          return Promise.resolve((state.releaseAssets.find((a) => a.release_id === params[0] && a.name === params[1]) ?? null) as T | null);
        }
        if (q.includes('COUNT(*) AS count FROM release_assets WHERE release_id = ?')) {
          return Promise.resolve({ count: state.releaseAssets.filter((a) => a.release_id === params[0]).length } as unknown as T);
        }
        if (q.includes('FROM releases WHERE repository_id = ? AND tag_name = ?')) {
          return Promise.resolve(
            (state.releases.find((r) => r.repository_id === params[0] && r.tag_name === params[1]) ?? null) as T | null,
          );
        }
        if (q.includes('FROM releases WHERE id = ? AND repository_id = ?')) {
          return Promise.resolve((state.releases.find((r) => r.id === params[0] && r.repository_id === params[1]) ?? null) as T | null);
        }
        if (q.includes('COUNT(*) AS count FROM releases')) {
          return Promise.resolve({ count: state.releases.filter((r) => r.repository_id === params[0]).length } as unknown as T);
        }
        if (q.includes('COUNT(*)')) return Promise.resolve({ n: 0, count: 0 } as unknown as T);
        if (q.includes('COALESCE(MAX(number)')) return Promise.resolve({ max_n: 0, next_number: 1 } as unknown as T);
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (
          q.includes('FROM repo_fts') ||
          q.includes('FROM issue_fts') ||
          q.includes('FROM pull_fts') ||
          q.includes('FROM code_fts') ||
          q.includes('FROM discussion_fts') ||
          q.includes('FROM snippet_fts')
        )
          return Promise.resolve({ results: [] });
        if (q.includes('FROM code_index')) return Promise.resolve({ results: [] });
        // LIKE fallbacks for search -> empty (still 200)
        if (q.includes('LIKE')) {
          if (
            q.includes('FROM repositories') ||
            q.includes('FROM issues') ||
            q.includes('FROM pull_requests') ||
            q.includes('FROM discussions') ||
            q.includes('FROM snippets') ||
            q.includes('FROM wiki_pages')
          ) {
            // wiki LIKE search without FTS should still return [] here; real rows covered by non-LIKE branch
            if (q.includes('FROM wiki_pages') && !q.includes('ORDER BY updated_at DESC LIMIT')) {
              // wiki searchByRepo LIKE query
              return Promise.resolve({ results: [] as T[] });
            }
            // For search fallbacks return empty
            if (q.includes('ESCAPE')) return Promise.resolve({ results: [] });
          }
        }
        if (q.includes('FROM repositories WHERE') && q.includes('owner_email')) {
          return Promise.resolve({ results: state.repos.filter((r) => String(r.owner_email).toLowerCase() === Pl(0)) as T[] });
        }
        if (q.includes('FROM repositories WHERE owner_ci = ?') && !q.includes('AND name_ci')) {
          return Promise.resolve({ results: state.repos.filter((r) => String(r.owner_ci ?? r.owner).toLowerCase() === Pl(0)) as T[] });
        }
        if (q.includes('FROM repositories WHERE org_id = ?')) {
          return Promise.resolve({ results: state.repos.filter((r) => r.org_id === params[0]) as T[] });
        }
        if (q.includes('FROM repositories WHERE')) {
          // generic search LIKE fallback already handled; default empty
          return Promise.resolve({ results: [] as T[] });
        }
        if (q.includes('FROM organization_members WHERE org_id = ? ORDER BY')) {
          return Promise.resolve({ results: state.orgMembers.filter((m) => m.org_id === params[0]) as T[] });
        }
        if (q.includes('FROM organization_members WHERE lower(user_email)')) {
          return Promise.resolve({ results: state.orgMembers.filter((m) => String(m.user_email).toLowerCase() === Pl(0)) as T[] });
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
          const includeArchived = !q.includes('archived = 0');
          let rows = state.projectCards.filter((c) => c.project_id === params[0]);
          if (!includeArchived) rows = rows.filter((c) => c.archived === 0);
          return Promise.resolve({ results: rows as T[] });
        }
        if (q.includes('FROM discussion_categories WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.discussionCategories.filter((c) => c.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM discussions WHERE repository_id = ? AND category_id = ?')) {
          return Promise.resolve({
            results: state.discussions.filter((d) => d.repository_id === params[0] && d.category_id === params[1]) as T[],
          });
        }
        if (q.includes('FROM discussions WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.discussions.filter((d) => d.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM discussion_comments WHERE discussion_id = ?')) {
          return Promise.resolve({ results: state.discussionComments.filter((c) => c.discussion_id === params[0]) as T[] });
        }
        if (q.includes('FROM wiki_pages WHERE repository_id = ?') && !q.includes('LIKE')) {
          return Promise.resolve({ results: state.wikiPages.filter((w) => w.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM wiki_revisions WHERE page_id = ?')) {
          return Promise.resolve({ results: state.wikiRevisions.filter((r) => r.page_id === params[0]) as T[] });
        }
        if (q.includes('FROM repo_stars WHERE user_email = ?')) {
          return Promise.resolve({
            results: state.stars.filter((s) => String(s.user_email).toLowerCase() === Pl(0)).map((s) => ({ repo_id: s.repo_id })) as T[],
          });
        }
        if (q.includes('FROM repo_watches WHERE user_email = ?')) {
          return Promise.resolve({
            results: state.watches.filter((s) => String(s.user_email).toLowerCase() === Pl(0)).map((s) => ({ repo_id: s.repo_id })) as T[],
          });
        }
        if (q.includes('FROM repo_watches WHERE repo_id = ?')) {
          return Promise.resolve({ results: state.watches.filter((s) => s.repo_id === params[0]) as T[] });
        }
        if (q.includes('FROM notifications WHERE user_email = ?')) {
          const rows = state.notifications
            .filter((n) => String(n.user_email).toLowerCase() === Pl(0))
            .sort((a, b) => (b.created_at as number) - (a.created_at as number));
          // handle LIMIT param (pageSize last)
          const limit = typeof params[params.length - 1] === 'number' ? (params[params.length - 1] as number) : rows.length;
          return Promise.resolve({ results: rows.slice(0, Math.min(limit, rows.length)) as T[] });
        }
        if (q.includes('FROM repo_events WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.events.filter((e) => e.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM pull_review_threads WHERE pull_request_id = ?')) {
          return Promise.resolve({ results: state.threads.filter((t) => t.pull_request_id === params[0]) as T[] });
        }
        if (q.includes('FROM pull_thread_comments WHERE thread_id = ?')) {
          return Promise.resolve({ results: state.threadComments.filter((c) => c.thread_id === params[0]) as T[] });
        }
        if (q.includes('FROM releases WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.releases.filter((r) => r.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM release_assets WHERE release_id = ?')) {
          return Promise.resolve({ results: state.releaseAssets.filter((a) => a.release_id === params[0]) as T[] });
        }
        if (q.includes('FROM release_assets WHERE repository_id = ?')) {
          return Promise.resolve({ results: state.releaseAssets.filter((a) => a.repository_id === params[0]) as T[] });
        }
        if (q.includes('FROM issues WHERE')) return Promise.resolve({ results: [] as T[] });
        if (q.includes('FROM pull_requests WHERE'))
          return Promise.resolve({
            results: state.pulls.filter((p) => (params.length > 0 && p.repository_id === params[0] ? true : true)) as T[],
          });
        return Promise.resolve({ results: [] as T[] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        // users
        if (q.startsWith('INSERT INTO users')) {
          if (!state.users.some((u) => u.email === params[0])) state.users.push({ email: params[0], created_at: params[1] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE users SET')) {
          const row = state.users.find((u) => String(u.email).toLowerCase() === String(params[params.length - 1]).toLowerCase());
          if (row) {
            // ensureUsername: COALESCE, setUsername: direct
            if (q.includes('username = ?') || q.includes('username = COALESCE')) row.username = (params[0] as string) ?? row.username;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // namespaces
        if (q.startsWith('INSERT INTO namespaces') || q.startsWith('INSERT OR IGNORE INTO namespaces')) {
          if (!state.namespaces.some((n) => n.username_ci === params[0]))
            state.namespaces.push({ username_ci: params[0], kind: params[1], user_email: params[2] ?? null, org_id: params[3] ?? null });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM namespaces WHERE username_ci = ?')) {
          state.namespaces = state.namespaces.filter((n) => n.username_ci !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // organizations
        if (q.startsWith('INSERT INTO organizations')) {
          state.organizations.push({
            id: params[0],
            username: params[1],
            username_ci: params[2],
            creator_email: params[3],
            created_at: params[4],
            updated_at: params[5],
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE organizations SET username = ?')) {
          const row = state.organizations.find((o) => o.id === params[3]);
          if (row) {
            row.username = params[0];
            row.username_ci = params[1];
            row.updated_at = params[2];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM organizations WHERE id = ?')) {
          state.organizations = state.organizations.filter((o) => o.id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // org members
        if (q.startsWith('DELETE FROM organization_members WHERE org_id = ? AND lower(user_email)')) {
          const before = state.orgMembers.length;
          state.orgMembers = state.orgMembers.filter((m) => !(m.org_id === params[0] && String(m.user_email).toLowerCase() === Pl(1)));
          return Promise.resolve({ success: true, meta: { changes: before - state.orgMembers.length } });
        }
        if (q.startsWith('INSERT INTO organization_members')) {
          const existing = state.orgMembers.find((m) => m.org_id === params[0] && String(m.user_email).toLowerCase() === Pl(1));
          if (existing) existing.role = params[2];
          else
            state.orgMembers.push({
              org_id: params[0],
              user_email: String(params[1]).toLowerCase(),
              role: params[2],
              created_at: params[3],
            });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM organization_members WHERE org_id = ?') && !q.includes('lower(user_email)')) {
          state.orgMembers = state.orgMembers.filter((m) => m.org_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // repositories rename cascade
        if (q.startsWith('UPDATE repositories SET owner = ?')) {
          const newOwner = params[0] as string;
          const oldCi = String(params[params.length - 1]).toLowerCase();
          for (const r of state.repos) {
            if (String(r.owner).toLowerCase() === oldCi || String(r.owner_ci ?? '').toLowerCase() === oldCi) {
              r.owner = newOwner;
              r.owner_ci = newOwner.toLowerCase();
            }
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // projects
        if (q.startsWith('INSERT INTO projects')) {
          state.projects.push({
            id: params[0],
            repository_id: params[1],
            number: params[2],
            title: params[3],
            description: params[4],
            status: 'open',
            creator_email: params[5],
            created_at: params[6],
            updated_at: params[7],
          });
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
          const repo = params[params.length - 1];
          const now = params[params.length - 3];
          const row = state.projects.find((p) => p.id === id && p.repository_id === repo);
          if (row) {
            const values = params.slice(0, params.length - 3) as Array<string | null>;
            let vi = 0;
            if (q.includes('title = ?')) row.title = values[vi++] as string;
            if (q.includes('description = ?')) row.description = values[vi++] as string | null;
            row.updated_at = now;
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
          state.projectCards.push({
            id: params[0],
            project_id: params[1],
            column_id: params[2],
            kind: params[3],
            note_title: params[4],
            note_body: params[5],
            issue_id: params[6],
            pull_request_id: params[7],
            position: params[8],
            archived: 0,
            creator_email: params[9],
            created_at: params[10],
            updated_at: params[11],
          });
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
        // discussions
        if (q.startsWith('INSERT INTO discussion_categories') || q.startsWith('INSERT OR IGNORE INTO discussion_categories')) {
          if (!state.discussionCategories.some((c) => c.id === params[0])) {
            state.discussionCategories.push({
              id: params[0],
              repository_id: params[1],
              slug: params[2],
              title: params[3],
              description: params[4],
              kind: params[5],
              created_at: params[6],
            });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO discussions')) {
          state.discussions.push({
            id: params[0],
            repository_id: params[1],
            category_id: params[2],
            number: params[3],
            title: params[4],
            body: params[5],
            author_email: params[6],
            status: 'open',
            created_at: params[7],
            updated_at: params[8],
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE discussions SET status = ?')) {
          const row = state.discussions.find((d) => d.id === params[2]);
          if (row) {
            row.status = params[0];
            row.updated_at = params[1];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE discussions SET')) {
          const id = params[params.length - 1];
          const now = params[params.length - 2];
          const row = state.discussions.find((d) => d.id === id);
          if (row) {
            const values = params.slice(0, params.length - 2) as Array<string | null>;
            let vi = 0;
            if (q.includes('title = ?')) row.title = values[vi++] as string;
            if (q.includes('body = ?')) row.body = values[vi++] as string | null;
            if (q.includes('category_id = ?')) row.category_id = values[vi++] as string | null;
            row.updated_at = now;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM discussion_comments WHERE discussion_id = ?') && params.length === 1) {
          state.discussionComments = state.discussionComments.filter((c) => c.discussion_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM discussions WHERE id = ?')) {
          state.discussions = state.discussions.filter((d) => d.id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO discussion_comments')) {
          state.discussionComments.push({
            id: params[0],
            discussion_id: params[1],
            author_email: params[2],
            body: params[3],
            created_at: params[4],
            updated_at: params[5],
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE discussion_comments SET')) {
          const row = state.discussionComments.find((c) => c.id === params[2] && c.discussion_id === params[3]);
          if (row) {
            row.body = params[0];
            row.updated_at = params[1];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM discussion_comments WHERE id = ?')) {
          state.discussionComments = state.discussionComments.filter((c) => !(c.id === params[0] && c.discussion_id === params[1]));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM discussion_categories WHERE repository_id = ?')) {
          state.discussionCategories = state.discussionCategories.filter((c) => c.repository_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // wiki
        if (q.startsWith('INSERT INTO wiki_pages')) {
          state.wikiPages.push({
            id: params[0],
            repository_id: params[1],
            slug: params[2],
            title: params[3],
            body: params[4],
            revision: 1,
            updated_by: params[5],
            created_at: params[6],
            updated_at: params[7],
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO wiki_revisions') || q.startsWith('INSERT OR IGNORE INTO wiki_revisions')) {
          if (params.length === 5) {
            if (!state.wikiRevisions.some((r) => r.id === params[0]))
              state.wikiRevisions.push({
                id: params[0],
                page_id: params[1],
                revision: 1,
                body: params[2],
                author_email: params[3],
                created_at: params[4],
              });
          } else {
            if (!state.wikiRevisions.some((r) => r.id === params[0]))
              state.wikiRevisions.push({
                id: params[0],
                page_id: params[1],
                revision: params[2],
                body: params[3],
                author_email: params[4],
                created_at: params[5],
              });
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE wiki_pages SET')) {
          const row = state.wikiPages.find((w) => w.id === params[5] && w.repository_id === params[6]);
          if (row) {
            row.title = params[0];
            row.body = params[1];
            row.revision = params[2];
            row.updated_by = params[3];
            row.updated_at = params[4];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM wiki_revisions WHERE page_id = ?')) {
          state.wikiRevisions = state.wikiRevisions.filter((r) => r.page_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM wiki_pages WHERE id = ?')) {
          state.wikiPages = state.wikiPages.filter((w) => !(w.id === params[0] && w.repository_id === params[1]));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // mirrors
        if (q.startsWith('INSERT INTO repo_mirrors')) {
          const existing = state.mirrors.find((m) => m.repository_id === params[0]);
          if (existing) {
            existing.source_url = params[1];
            existing.interval_minutes = params[2];
            existing.enabled = 1;
            existing.updated_at = params[5];
          } else
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
        if (q.startsWith('UPDATE repo_mirrors SET last_run_at')) {
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repo_mirrors WHERE repository_id = ?')) {
          state.mirrors = state.mirrors.filter((m) => m.repository_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // stars / watches
        if (q.startsWith('INSERT OR IGNORE INTO repo_stars')) {
          if (!state.stars.some((s) => s.repo_id === params[0] && String(s.user_email).toLowerCase() === String(params[1]).toLowerCase()))
            state.stars.push({ repo_id: params[0], user_email: String(params[1]).toLowerCase(), created_at: params[2] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repo_stars WHERE repo_id = ? AND user_email = ?')) {
          state.stars = state.stars.filter(
            (s) => !(s.repo_id === params[0] && String(s.user_email).toLowerCase() === String(params[1]).toLowerCase()),
          );
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT OR IGNORE INTO repo_watches')) {
          if (!state.watches.some((s) => s.repo_id === params[0] && String(s.user_email).toLowerCase() === String(params[1]).toLowerCase()))
            state.watches.push({ repo_id: params[0], user_email: String(params[1]).toLowerCase(), created_at: params[2] });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM repo_watches WHERE repo_id = ? AND user_email = ?')) {
          state.watches = state.watches.filter(
            (s) => !(s.repo_id === params[0] && String(s.user_email).toLowerCase() === String(params[1]).toLowerCase()),
          );
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // notifications
        if (q.startsWith('INSERT OR IGNORE INTO notifications')) {
          if (!state.notifications.some((n) => n.id === params[0]))
            state.notifications.push({
              id: params[0],
              user_email: String(params[1]).toLowerCase(),
              repository_id: params[2],
              full_name: params[3],
              actor_email: params[4],
              type: params[5],
              title: params[6],
              subject_type: params[7] ?? null,
              subject_number: params[8] ?? null,
              is_read: 0,
              created_at: params[9],
            });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_email = ?')) {
          const row = state.notifications.find(
            (n) => n.id === params[0] && String(n.user_email).toLowerCase() === String(params[1]).toLowerCase(),
          );
          if (row) {
            row.is_read = 1;
            return Promise.resolve({ success: true, meta: { changes: 1 } });
          }
          return Promise.resolve({ success: true, meta: { changes: 0 } });
        }
        if (q.startsWith('UPDATE notifications SET is_read = 1 WHERE user_email = ?')) {
          let changed = 0;
          for (const n of state.notifications) {
            if (String(n.user_email).toLowerCase() === String(params[0]).toLowerCase() && n.is_read === 0) {
              n.is_read = 1;
              changed += 1;
            }
          }
          return Promise.resolve({ success: true, meta: { changes: changed } });
        }
        // events
        if (q.startsWith('INSERT INTO repo_events')) {
          state.events.push({
            id: params[0],
            repository_id: params[1],
            full_name: params[2],
            actor_email: params[3],
            type: params[4],
            subject_type: params[5] ?? null,
            subject_number: params[6] ?? null,
            subject_oid: params[7] ?? null,
            payload: params[8] ?? '{}',
            created_at: params[9],
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // threads
        if (q.startsWith('INSERT INTO pull_review_threads')) {
          state.threads.push({
            id: params[0],
            pull_request_id: params[1],
            path: params[2],
            line: params[3],
            side: params[4],
            commit_oid: params[5],
            status: 'open',
            author_email: String(params[7]).toLowerCase(),
            created_at: params[8],
            resolved_by: null,
            resolved_at: null,
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO pull_thread_comments')) {
          state.threadComments.push({
            id: params[0],
            thread_id: params[1],
            author_email: String(params[2]).toLowerCase(),
            body: params[3],
            created_at: params[4],
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE pull_review_threads SET status = ?')) {
          const row = state.threads.find((t) => t.id === params[3]);
          if (row) {
            row.status = params[0];
            row.resolved_by = params[1];
            row.resolved_at = params[2];
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        // releases
        if (q.startsWith('INSERT INTO releases')) {
          state.releases.push({
            id: params[0],
            repository_id: params[1],
            tag_name: params[2],
            name: params[3],
            body: params[4],
            is_draft: params[5],
            is_prerelease: params[6],
            created_by: params[7],
            created_at: params[8],
            published_at: params[9],
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE releases SET')) {
          const id = params[params.length - 2];
          const repo = params[params.length - 1];
          const row = state.releases.find((r) => r.id === id && r.repository_id === repo);
          if (row) {
            const values = params.slice(0, params.length - 2) as Array<string | number | null>;
            let vi = 0;
            if (q.includes('name = ?')) row.name = values[vi++] as string;
            if (q.includes('body = ?')) row.body = values[vi++] as string;
            if (q.includes('is_draft = ?')) row.is_draft = values[vi++] ? 1 : 0;
            if (q.includes('is_prerelease = ?')) row.is_prerelease = values[vi++] ? 1 : 0;
            if (q.includes('published_at = ?')) row.published_at = values[vi++] as number | null;
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM releases WHERE id = ?')) {
          state.releases = state.releases.filter((r) => !(r.id === params[0] && r.repository_id === params[1]));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT INTO release_assets')) {
          state.releaseAssets.push({
            id: params[0],
            release_id: params[1],
            repository_id: params[2],
            name: params[3],
            size: params[4],
            content_type: params[5],
            sha256: params[6],
            created_by: params[7],
            created_at: params[8],
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM release_assets WHERE id = ?')) {
          state.releaseAssets = state.releaseAssets.filter((a) => !(a.id === params[0] && a.release_id === params[1]));
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM release_assets WHERE release_id = ?')) {
          state.releaseAssets = state.releaseAssets.filter((a) => a.release_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM release_assets WHERE repository_id = ?')) {
          state.releaseAssets = state.releaseAssets.filter((a) => a.repository_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        return Promise.resolve({ success: true, meta: { changes: 1 } });
      },
    };
  }
  const db = { prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) };
  return { db: db as unknown as D1Queryable, state };
}

function createDoStub(assetStore?: Map<string, Uint8Array>) {
  const store = assetStore ?? new Map<string, Uint8Array>();
  return {
    setFullName: () => Promise.resolve(),
    ensureRepoInitialized: () => Promise.resolve(),
    deleteRepo: () => Promise.resolve(),
    listRefs: () => Promise.resolve({ refs: [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }], symbolicHead: 'refs/heads/main' }),
    getBranches: () => Promise.resolve({ branches: ['main'], currentBranch: 'main' }),
    getTree: () => Promise.resolve([]),
    getBlob: () => Promise.resolve(null),
    getCommits: () => Promise.resolve([]),
    getOverview: () =>
      Promise.resolve({
        branches: ['main'],
        currentBranch: 'main',
        resolvedRef: 'a'.repeat(40),
        tags: [],
        tree: [],
        commits: [],
        readme: null,
      }),
    getTags: () => Promise.resolve([]),
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
    getReleaseAsset: ({ assetId }: { assetId: string }) => Promise.resolve(store.get(assetId) ?? null),
    storeReleaseAsset: ({ assetId, bytes }: { assetId: string; bytes: Uint8Array }) => {
      store.set(assetId, bytes);
      return Promise.resolve({ ok: true });
    },
    deleteReleaseAsset: ({ assetId }: { assetId: string }) => {
      store.delete(assetId);
      return Promise.resolve({ ok: true });
    },
    deleteReleaseAssets: () => Promise.resolve({ ok: true }),
    enqueueChecks: () => Promise.resolve({ ok: true }),
    issueTicket: ({ shard, channels }: { shard: string; channels: string[] }) =>
      Promise.resolve({ ticket: `ticket-for-${shard}`, expiresAt: 9999999999, channels }),
    publish: () => Promise.resolve({ delivered: 0 }),
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

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined };
const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function callWorker(env: unknown, path: string, init?: RequestInit): Promise<Response> {
  const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
  return worker.onRequest(new Request(`https://git.example.com${path}`, init), env, CTX);
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

// --- OrgRoutes -------------------------------------------------------------
describe('OrgRoutes low fill', () => {
  it('creates an org and claims namespace', async () => {
    const { db, state } = createLowFakeDb();
    const res = await callWorker(createEnv(db), '/user/orgs', postJson({ username: 'neworg' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { username: string };
    expect(body.username).toBe('neworg');
    expect(state.organizations.some((o) => o.username === 'neworg')).toBe(true);
    expect(state.namespaces.some((n) => n.username_ci === 'neworg')).toBe(true);
  });

  it('rejects invalid org names', async () => {
    const { db } = createLowFakeDb();
    expect((await callWorker(createEnv(db), '/user/orgs', postJson({ username: 'bad name!' }))).status).toBe(400);
    expect((await callWorker(createEnv(db), '/user/orgs', postJson({}))).status).toBe(400);
  });

  it('rejects taken org names', async () => {
    const { db } = createLowFakeDb();
    expect((await callWorker(createEnv(db), '/user/orgs', postJson({ username: 'alice' }))).status).toBe(400);
  });

  it('adds a member and validates role/target', async () => {
    const { db, state } = createLowFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, '/user/orgs/acme/members', postJson({}))).status).toBe(400);
    expect((await callWorker(env, '/user/orgs/acme/members', postJson({ email: BOB, role: 'superadmin' }))).status).toBe(400);
    const ok = await callWorker(env, '/user/orgs/acme/members', postJson({ email: BOB, role: 'member' }));
    expect(ok.status).toBe(201);
    expect(state.orgMembers.some((m) => String(m.user_email).toLowerCase() === BOB)).toBe(true);
  });

  it('guards the last owner on remove and demote', async () => {
    const { db, state } = createLowFakeDb();
    const env = createEnv(db);
    const before = state.orgMembers.length;
    const del = await callWorker(env, `/user/orgs/acme/members/${encodeURIComponent(ALICE)}`, { method: 'DELETE' });
    expect(del.status).toBe(400);
    expect(
      await del
        .json()
        .then((b) => (b as { Exception?: { Message?: string } }).Exception?.Message ?? '')
        .catch(() => ''),
    ).toContain('last owner');
    expect(state.orgMembers).toHaveLength(before);
    const demote = await callWorker(env, `/user/orgs/acme/members/${encodeURIComponent(ALICE)}`, patchJson({ role: 'member' }));
    expect(demote.status).toBe(400);
    expect(state.orgMembers.find((m) => m.user_email === ALICE)?.role).toBe('owner');
  });

  it('validates org rename', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, '/user/orgs/acme', patchJson({ username: 'bad name!' }))).status).toBe(400);
    expect((await callWorker(env, '/user/orgs/acme', patchJson({ username: 'alice' }))).status).toBe(400);
    const ok = await callWorker(env, '/user/orgs/acme', patchJson({ username: 'acme2' }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { username: string }).username).toBe('acme2');
  });
});

// --- ProjectRoutes ----------------------------------------------------------
describe('ProjectRoutes low fill', () => {
  it('creates a project with seeded columns', async () => {
    const { db, state } = createLowFakeDb();
    const res = await callWorker(createEnv(db), '/user/repos/alice/demo/projects', postJson({ title: 'Board' }));
    expect(res.status).toBe(201);
    expect(state.projects).toHaveLength(1);
    expect(state.projectColumns).toHaveLength(3);
  });

  it('rejects project without title', async () => {
    const { db, state } = createLowFakeDb();
    expect((await callWorker(createEnv(db), '/user/repos/alice/demo/projects', postJson({ title: '' }))).status).toBe(400);
    expect(state.projects).toHaveLength(0);
  });

  it('rejects bad project numbers', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, '/repos/alice/demo/projects/nope')).status).toBe(400);
    expect((await callWorker(env, '/user/repos/alice/demo/projects/0')).status).toBe(400);
  });

  it('creates columns and rejects duplicates', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    await callWorker(env, '/user/repos/alice/demo/projects', postJson({ title: 'Board' }));
    const ok = await callWorker(env, '/user/repos/alice/demo/projects/1/columns', postJson({ title: 'Backlog' }));
    expect(ok.status).toBe(201);
    const dup = await callWorker(env, '/user/repos/alice/demo/projects/1/columns', postJson({ title: 'Todo' }));
    expect(dup.status).toBe(400);
  });

  it('enforces column limits', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db, { MAX_COLUMNS_PER_PROJECT: '3' });
    await callWorker(env, '/user/repos/alice/demo/projects', postJson({ title: 'Board' }));
    const res = await callWorker(env, '/user/repos/alice/demo/projects/1/columns', postJson({ title: 'Extra' }));
    expect(res.status).toBe(400);
  });

  it('creates cards and validates columnId', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    await callWorker(env, '/user/repos/alice/demo/projects', postJson({ title: 'Board' }));
    const board = (await (await callWorker(env, '/user/repos/alice/demo/projects/1')).json()) as { columns: Array<{ id: string }> };
    const columnId = board.columns[0].id;
    expect((await callWorker(env, '/user/repos/alice/demo/projects/1/cards', postJson({ kind: 'note' }))).status).toBe(400);
    const ok = await callWorker(env, '/user/repos/alice/demo/projects/1/cards', postJson({ columnId, kind: 'note', noteTitle: 'Task' }));
    expect(ok.status).toBe(201);
  });

  it('enforces card-per-column limits', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db, { MAX_CARDS_PER_COLUMN: '1' });
    await callWorker(env, '/user/repos/alice/demo/projects', postJson({ title: 'Board' }));
    const board = (await (await callWorker(env, '/user/repos/alice/demo/projects/1')).json()) as { columns: Array<{ id: string }> };
    const columnId = board.columns[0].id;
    expect((await callWorker(env, '/user/repos/alice/demo/projects/1/cards', postJson({ columnId, noteTitle: 'one' }))).status).toBe(201);
    expect((await callWorker(env, '/user/repos/alice/demo/projects/1/cards', postJson({ columnId, noteTitle: 'two' }))).status).toBe(400);
  });
});

// --- DiscussionRoutes -------------------------------------------------------
describe('DiscussionRoutes low fill', () => {
  it('creates a discussion', async () => {
    const { db, state } = createLowFakeDb();
    const res = await callWorker(createEnv(db), '/user/repos/alice/demo/discussions', postJson({ title: 'Hello', body: 'world' }));
    expect(res.status).toBe(201);
    expect(state.discussions).toHaveLength(1);
  });

  it('rejects discussion without title and bad numbers', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, '/user/repos/alice/demo/discussions', postJson({ title: '' }))).status).toBe(400);
    expect((await callWorker(env, '/repos/alice/demo/discussions/nope')).status).toBe(400);
    expect((await callWorker(env, '/user/repos/alice/demo/discussions/0')).status).toBe(400);
  });

  it('comments on a discussion and validates body', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    await callWorker(env, '/user/repos/alice/demo/discussions', postJson({ title: 'Hello' }));
    expect((await callWorker(env, '/user/repos/alice/demo/discussions/1/comments', postJson({ body: '' }))).status).toBe(400);
    const ok = await callWorker(env, '/user/repos/alice/demo/discussions/1/comments', postJson({ body: 'nice' }));
    expect(ok.status).toBe(201);
  });

  it('closes a discussion via status', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    await callWorker(env, '/user/repos/alice/demo/discussions', postJson({ title: 'Hello' }));
    const locked = await callWorker(env, '/user/repos/alice/demo/discussions/1', patchJson({ status: 'locked' }));
    expect(locked.status).toBe(200);
    expect(((await locked.json()) as { discussion: { status: string } }).discussion.status).toBe('locked');
    expect((await callWorker(env, '/user/repos/alice/demo/discussions/1', patchJson({ status: 'bogus' }))).status).toBe(400);
  });
});

// --- RealtimeRoutes ---------------------------------------------------------
describe('RealtimeRoutes low fill', () => {
  it('issues a repo ticket when enabled', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db, { REALTIME_ENABLED: 'true' });
    const res = await callWorker(env, '/user/realtime/ticket', postJson({ owner: 'alice', repo: 'demo', channels: ['activity'] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shard: string; ticket: string; channels: string[] };
    expect(body.shard).toContain('repo:');
    expect(body.ticket.length).toBeGreaterThan(0);
    expect(body.channels).toContain('activity');
  });

  it('validates ticket input', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db, { REALTIME_ENABLED: 'true' });
    expect((await callWorker(env, '/user/realtime/ticket', postJson({ channels: ['activity'] }))).status).toBe(400);
    expect(
      (await callWorker(env, '/user/realtime/ticket', postJson({ owner: 'bad name!', repo: 'demo', channels: ['activity'] }))).status,
    ).toBe(400);
    expect((await callWorker(env, '/user/realtime/ticket', postJson({ owner: 'alice', repo: 'demo', channels: ['bogus'] }))).status).toBe(
      403,
    );
  });

  it('issues an inbox ticket when enabled', async () => {
    const { db } = createLowFakeDb();
    const res = await callWorker(createEnv(db, { REALTIME_ENABLED: 'true' }), '/user/realtime/inbox-ticket');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { shard: string }).shard).toBe('inbox:global');
  });

  it('returns 503 when realtime is disabled', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    expect(
      (await callWorker(env, '/user/realtime/ticket', postJson({ owner: 'alice', repo: 'demo', channels: ['activity'] }))).status,
    ).toBe(503);
    expect((await callWorker(env, '/user/realtime/inbox-ticket')).status).toBe(503);
    expect((await callWorker(env, '/realtime/ws?shard=repo:alice/demo')).status).toBe(503);
  });

  it('requires websocket upgrade on the public gateway', async () => {
    const { db } = createLowFakeDb();
    const res = await callWorker(createEnv(db, { REALTIME_ENABLED: 'true' }), '/realtime/ws?shard=repo:alice/demo');
    expect(res.status).toBe(426);
    expect((await callWorker(createEnv(db, { REALTIME_ENABLED: 'true' }), '/realtime/ws?shard=bogus')).status).toBe(404);
  });
});

// --- PullThreadRoutes -------------------------------------------------------
describe('PullThreadRoutes low fill', () => {
  it('opens a thread', async () => {
    const { db } = createLowFakeDb();
    const res = await callWorker(
      createEnv(db),
      '/user/repos/alice/demo/pulls/1/threads',
      postJson({ path: 'f.txt', line: 1, body: 'note' }),
    );
    expect(res.status).toBe(201);
  });

  it('validates thread open input', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, '/user/repos/alice/demo/pulls/1/threads', postJson({ path: 'f.txt', line: 1 }))).status).toBe(400);
    expect((await callWorker(env, '/user/repos/alice/demo/pulls/1/threads', postJson({ path: '../evil', body: 'x' }))).status).toBe(400);
    expect((await callWorker(env, '/user/repos/alice/demo/pulls/1/threads', postJson({ path: 'f.txt', line: 0, body: 'x' }))).status).toBe(
      400,
    );
    expect((await callWorker(env, '/user/repos/alice/demo/pulls/nope/threads', postJson({ path: 'f.txt', body: 'x' }))).status).toBe(404);
  });

  it('replies to a thread and validates body', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    const opened = (await (
      await callWorker(env, '/user/repos/alice/demo/pulls/1/threads', postJson({ path: 'f.txt', body: 'note' }))
    ).json()) as { thread: { id: string } };
    expect(
      (await callWorker(env, `/user/repos/alice/demo/pulls/1/threads/${opened.thread.id}/replies`, postJson({ body: '' }))).status,
    ).toBe(400);
    const ok = await callWorker(env, `/user/repos/alice/demo/pulls/1/threads/${opened.thread.id}/replies`, postJson({ body: 'reply' }));
    expect(ok.status).toBe(201);
  });

  it('validates resolve input', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    const opened = (await (
      await callWorker(env, '/user/repos/alice/demo/pulls/1/threads', postJson({ path: 'f.txt', body: 'note' }))
    ).json()) as { thread: { id: string } };
    expect(
      (await callWorker(env, `/user/repos/alice/demo/pulls/1/threads/${opened.thread.id}`, patchJson({ resolved: 'yes' }))).status,
    ).toBe(400);
    const ok = await callWorker(env, `/user/repos/alice/demo/pulls/1/threads/${opened.thread.id}`, patchJson({ resolved: true }));
    expect(ok.status).toBe(200);
  });

  it('forbids non-author non-writer resolves', async () => {
    const { db } = createLowFakeDb();
    const aliceEnv = createEnv(db);
    const opened = (await (
      await callWorker(aliceEnv, '/user/repos/alice/demo/pulls/1/threads', postJson({ path: 'f.txt', body: 'note' }))
    ).json()) as { thread: { id: string } };
    const bobEnv = createEnv(db, { DEV_AUTH_EMAIL: BOB });
    const res = await callWorker(bobEnv, `/user/repos/alice/demo/pulls/1/threads/${opened.thread.id}`, patchJson({ resolved: true }));
    expect(res.status).toBe(403);
  });
});

// --- ReleaseAssetRoutes -----------------------------------------------------
describe('ReleaseAssetRoutes low fill', () => {
  async function createDraftRelease(env: unknown): Promise<void> {
    const res = await callWorker(env, '/user/repos/alice/demo/releases', postJson({ tagName: 'v1', isDraft: true }));
    expect(res.status).toBe(201);
  }

  it('uploads base64 assets', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    await createDraftRelease(env);
    const res = await callWorker(
      env,
      '/user/repos/alice/demo/releases/v1/assets',
      postJson({ name: 'a.zip', contentBase64: Buffer.from('hi').toString('base64') }),
    );
    expect(res.status).toBe(201);
  });

  it('validates asset upload input', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    await createDraftRelease(env);
    expect((await callWorker(env, '/user/repos/alice/demo/releases/v1/assets', postJson({}))).status).toBe(400);
    expect(
      (await callWorker(env, '/user/repos/alice/demo/releases/v1/assets', postJson({ name: 'a.zip', contentBase64: '!!!not-base64!!!' })))
        .status,
    ).toBe(400);
  });

  it('returns 404 for missing asset bytes', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    await createDraftRelease(env);
    expect((await callWorker(env, '/user/repos/alice/demo/releases/v1/assets/nope/download')).status).toBe(404);
    expect((await callWorker(env, '/repos/alice/demo/releases/v1/assets/nope/download')).status).toBe(404);
  });

  it('downloads stored bytes', async () => {
    const { db } = createLowFakeDb();
    const store = new Map<string, Uint8Array>();
    const stub = createDoStub(store);
    const env = {
      DB: db,
      REPO: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
      CRON_TASKS: { get: () => stub, idFromName: (n: string) => n },
      CHECK_RUNNER: { get: () => stub, idFromName: (n: string) => n },
      REALTIME: { getByName: () => stub, get: () => stub, idFromName: (n: string) => n },
      ENVIRONMENT: 'development',
      DEV_AUTH_EMAIL: ALICE,
    };
    await createDraftRelease(env);
    const uploaded = (await (
      await callWorker(
        env,
        '/user/repos/alice/demo/releases/v1/assets',
        postJson({ name: 'a.zip', contentBase64: Buffer.from('hi').toString('base64') }),
      )
    ).json()) as { asset: { id: string } };
    const dl = await callWorker(env, `/user/repos/alice/demo/releases/v1/assets/${uploaded.asset.id}/download`);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('hi');
  });
});

// --- WikiRoutes -------------------------------------------------------------
describe('WikiRoutes low fill', () => {
  it('creates a wiki page', async () => {
    const { db, state } = createLowFakeDb();
    const res = await callWorker(createEnv(db), '/user/repos/alice/demo/wiki', postJson({ slug: 'home', title: 'Home', body: 'hi' }));
    expect(res.status).toBe(201);
    expect(state.wikiPages).toHaveLength(1);
  });

  it('rejects duplicate and invalid slugs', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    await callWorker(env, '/user/repos/alice/demo/wiki', postJson({ slug: 'home', title: 'Home' }));
    expect((await callWorker(env, '/user/repos/alice/demo/wiki', postJson({ slug: 'home', title: 'Again' }))).status).toBe(400);
    expect((await callWorker(env, '/user/repos/alice/demo/wiki', postJson({ slug: 'Bad Slug!', title: 'x' }))).status).toBe(400);
  });

  it('updates a page', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    await callWorker(env, '/user/repos/alice/demo/wiki', postJson({ slug: 'home', title: 'Home', body: 'v1' }));
    const res = await callWorker(env, '/user/repos/alice/demo/wiki/home', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ body: 'v2' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { page: { revision: number } }).page.revision).toBe(2);
  });

  it('returns 409 on revision conflict', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    await callWorker(env, '/user/repos/alice/demo/wiki', postJson({ slug: 'home', title: 'Home', body: 'v1' }));
    const res = await callWorker(env, '/user/repos/alice/demo/wiki/home', {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ body: 'v2', expectedRevision: 999 }),
    });
    expect(res.status).toBe(409);
  });

  it('reads and deletes pages', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    await callWorker(env, '/user/repos/alice/demo/wiki', postJson({ slug: 'home', title: 'Home' }));
    expect((await callWorker(env, '/user/repos/alice/demo/wiki/home')).status).toBe(200);
    expect((await callWorker(env, '/user/repos/alice/demo/wiki/home', { method: 'DELETE' })).status).toBe(200);
    expect((await callWorker(env, '/user/repos/alice/demo/wiki/home')).status).toBe(404);
  });
});

// --- MirrorRoutes -----------------------------------------------------------
describe('MirrorRoutes low fill', () => {
  it('configures a mirror', async () => {
    const { db, state } = createLowFakeDb();
    const res = await callWorker(
      createEnv(db),
      '/user/repos/alice/demo/mirror',
      putJson({ sourceUrl: 'https://github.com/o/r', intervalMinutes: 60 }),
    );
    expect(res.status).toBe(200);
    expect(state.mirrors).toHaveLength(1);
  });

  it('validates mirror input', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, '/user/repos/alice/demo/mirror', putJson({ intervalMinutes: 60 }))).status).toBe(400);
    expect(
      (await callWorker(env, '/user/repos/alice/demo/mirror', putJson({ sourceUrl: 'https://github.com/o/r', intervalMinutes: 5 }))).status,
    ).toBe(400);
    expect(
      (await callWorker(env, '/user/repos/alice/demo/mirror', putJson({ sourceUrl: 'http://github.com/o/r', intervalMinutes: 60 }))).status,
    ).toBe(400);
  });

  it('reads and toggles mirrors', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, '/user/repos/alice/demo/mirror')).status).toBe(404);
    await callWorker(env, '/user/repos/alice/demo/mirror', putJson({ sourceUrl: 'https://github.com/o/r', intervalMinutes: 60 }));
    expect((await callWorker(env, '/user/repos/alice/demo/mirror')).status).toBe(200);
    expect((await callWorker(env, '/user/repos/alice/demo/mirror/enable', postJson({ enabled: false }))).status).toBe(200);
    expect((await callWorker(env, '/user/repos/alice/demo/mirror/enable', postJson({}))).status).toBe(400);
  });

  it('deletes mirrors', async () => {
    const { db, state } = createLowFakeDb();
    const env = createEnv(db);
    await callWorker(env, '/user/repos/alice/demo/mirror', putJson({ sourceUrl: 'https://github.com/o/r', intervalMinutes: 60 }));
    expect((await callWorker(env, '/user/repos/alice/demo/mirror', { method: 'DELETE' })).status).toBe(200);
    expect(state.mirrors).toHaveLength(0);
  });
});

// --- SearchRoutes -----------------------------------------------------------
describe('SearchRoutes low fill', () => {
  it('requires q', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, '/search')).status).toBe(400);
    expect((await callWorker(env, '/search?q=a')).status).toBe(400);
  });

  it('rejects overlong and control-only queries', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, `/search?q=${'x'.repeat(201)}`)).status).toBe(400);
    expect((await callWorker(env, '/search?q=%1F%1F')).status).toBe(400);
  });

  it('searches and clamps limits', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    const ok = await callWorker(env, '/search?q=hello');
    expect(ok.status).toBe(200);
    const clamped = await callWorker(env, '/search?q=hello&limit=999');
    expect(clamped.status).toBe(200);
    expect(((await clamped.json()) as { query: string }).query).toBe('hello');
  });

  it('supports type filters', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    for (const type of ['repos', 'issues', 'pulls', 'code', 'discussions', 'snippets']) {
      const res = await callWorker(env, `/search?q=hello&type=${type}`);
      expect(res.status, type).toBe(200);
    }
  });
});

// --- SocialRoutes + notifications -------------------------------------------
describe('SocialRoutes low fill', () => {
  it('stars and unstars repos', async () => {
    const { db, state } = createLowFakeDb();
    const env = createEnv(db);
    const starred = await callWorker(env, '/user/repos/alice/demo/star', putJson({}));
    expect(starred.status).toBe(200);
    expect(state.stars).toHaveLength(1);
    expect((await callWorker(env, '/repos/alice/demo/stars')).status).toBe(200);
    const authedStar = (await (await callWorker(env, '/user/repos/alice/demo/star')).json()) as {
      starred: boolean;
      viewerStarred: boolean;
      starsCount: number;
      count: number;
    };
    expect(authedStar).toMatchObject({ starred: true, viewerStarred: true, starsCount: 1, count: 1 });
    const unstarred = await callWorker(env, '/user/repos/alice/demo/star', { method: 'DELETE' });
    expect(unstarred.status).toBe(200);
    expect(state.stars).toHaveLength(0);
    const authedUnstarred = (await (await callWorker(env, '/user/repos/alice/demo/star')).json()) as {
      starred: boolean;
      viewerStarred: boolean;
    };
    expect(authedUnstarred).toMatchObject({ starred: false, viewerStarred: false });
  });

  it('watches and unwatches repos', async () => {
    const { db, state } = createLowFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, '/user/repos/alice/demo/watch', putJson({}))).status).toBe(200);
    expect(state.watches).toHaveLength(1);
    expect((await callWorker(env, '/repos/alice/demo/watches')).status).toBe(200);
    const authedWatch = (await (await callWorker(env, '/user/repos/alice/demo/watch')).json()) as {
      watching: boolean;
      viewerWatching: boolean;
      watchersCount: number;
      count: number;
    };
    expect(authedWatch).toMatchObject({ watching: true, viewerWatching: true, watchersCount: 1, count: 1 });
    expect((await callWorker(env, '/user/repos/alice/demo/watch', { method: 'DELETE' })).status).toBe(200);
    expect(state.watches).toHaveLength(0);
  });

  it('lists personal stars and watches', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    await callWorker(env, '/user/repos/alice/demo/star', putJson({}));
    await callWorker(env, '/user/repos/alice/demo/watch', putJson({}));
    expect((await callWorker(env, '/user/stars')).status).toBe(200);
    expect((await callWorker(env, '/user/watches')).status).toBe(200);
    expect((await callWorker(env, '/repos/alice/demo/activity')).status).toBe(200);
  });

  it('lists notifications and unread counts', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    const list = await callWorker(env, '/user/notifications');
    expect(list.status).toBe(200);
    expect(((await list.json()) as { notifications: unknown[] }).notifications).toHaveLength(0);
    expect((await callWorker(env, '/user/notifications/unread-count')).status).toBe(200);
    expect((await callWorker(env, '/user/notifications/read-all', postJson({}))).status).toBe(200);
  });

  it('returns 404 for unknown notification reads', async () => {
    const { db } = createLowFakeDb();
    const env = createEnv(db);
    expect((await callWorker(env, '/user/notifications/nope/read', patchJson({}))).status).toBe(404);
  });
});
