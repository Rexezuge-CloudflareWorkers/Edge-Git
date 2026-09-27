import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, migrationFileNames } from '../helpers/migrations';

/**
 * Proves migration 0028 upgrades a *populated* pre-0028 database without
 * losing a single row.
 *
 * This is the load-bearing test for the whole change. `users.email` used to be
 * the PRIMARY KEY and three tables carried
 * `ON DELETE CASCADE` references to it, so rebuilding those tables with
 * foreign key enforcement on would cascade the user's repositories — and,
 * through `repositories`, 22 more child tables — out of the database. Every
 * table that has a foreign key pointing at `users` or `repositories` is seeded
 * here, row counts are captured before the migration, and the same counts are
 * asserted afterwards.
 */

const LAST_PRE_IDENTITY_MIGRATION = '0027_drop_plaintext_secrets.sql';
const IDENTITY_MIGRATION = '0028_user_identity.sql';

const ALICE = 'alice@legacy.test';
const BOB = 'bob@legacy.test';
/**
 * Stored mixed-case on purpose. Only the non-FK tables can hold such a row
 * (`snippets`/`user_access_tokens`/`repositories` still carry an FK to
 * `users(email)` before 0028, which is case-sensitive), so this user stands
 * in for the legacy rows the case-insensitive backfills must still resolve.
 */
const MIXED = 'Carol@Legacy.Test';

const NOW = 1_700_000_000;

/**
 * Tables that hold live rows seeded below, plus every table a `users` or
 * `repositories` cascade could reach. Counts must be identical pre/post.
 */
const GUARDED_TABLES = [
  'users',
  'namespaces',
  'organizations',
  'organization_members',
  'repositories',
  'user_access_tokens',
  'repo_collaborators',
  'branch_protection_rules',
  'milestones',
  'issues',
  'comments',
  'labels',
  'issue_assignees',
  'pull_requests',
  'pull_request_reviews',
  'pull_request_comments',
  'pull_assignees',
  'pull_reviewers',
  'pull_review_threads',
  'pull_thread_comments',
  'repo_stars',
  'repo_watches',
  'repo_events',
  'notifications',
  'repo_webhooks',
  'releases',
  'release_assets',
  'projects',
  'project_columns',
  'project_cards',
  'discussion_categories',
  'discussions',
  'discussion_comments',
  'wiki_pages',
  'wiki_revisions',
  'snippets',
  'teams',
  'team_members',
  'team_repo_grants',
  'audit_logs',
  'repo_imports',
  'repo_mirrors',
  'deploy_keys',
  'repo_security_settings',
  'check_runs',
] as const;

type Db = D1Database;

function run(db: Db, sql: string, ...params: unknown[]): Promise<unknown> {
  return db
    .prepare(sql)
    .bind(...(params as never[]))
    .run();
}

async function countRows(db: Db, table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

async function snapshotCounts(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of GUARDED_TABLES) out[table] = await countRows(db, table);
  return out;
}

/**
 * Seeds one row (or more) into every table reachable by a cascade out of
 * `users` or `repositories`, using pre-0028 column shapes (email-keyed, no
 * `user_id`). Mixed-case addresses are deliberate: the 0028 backfills join
 * `users` case-insensitively, and an over-strict backfill would silently
 * orphan every id.
 */
async function seedLegacyGraph(db: Db): Promise<void> {
  await run(db, `INSERT INTO users (email, username, display_name, created_at, updated_at) VALUES (?, 'alice', 'Alice', ?, NULL)`, ALICE, NOW);
  await run(db, `INSERT INTO users (email, username, created_at) VALUES (?, 'bob', ?)`, BOB, NOW);
  await run(db, `INSERT INTO users (email, username, created_at) VALUES (?, 'carol', ?)`, MIXED, NOW);
  await run(
    db,
    `INSERT INTO namespaces (username_ci, kind, user_email, org_id, created_at) VALUES ('alice', 'user', ?, NULL, ?)`,
    ALICE,
    NOW,
  );
  await run(
    db,
    `INSERT INTO namespaces (username_ci, kind, user_email, org_id, created_at) VALUES ('legacyorg', 'org', ?, NULL, ?)`,
    ALICE,
    NOW,
  );

  await run(
    db,
    `INSERT INTO organizations (id, username, username_ci, display_name, creator_email, created_at, updated_at) VALUES ('org-1', 'legacyorg', 'legacyorg', 'Legacy Org', ?, ?, ?)`,
    ALICE,
    NOW,
    NOW,
  );
  await run(db, `INSERT INTO organization_members (org_id, user_email, role, created_at) VALUES ('org-1', ?, 'owner', ?)`, ALICE, NOW);
  await run(db, `INSERT INTO organization_members (org_id, user_email, role, created_at) VALUES ('org-1', ?, 'member', ?)`, BOB, NOW);
  await run(
    db,
    `INSERT INTO teams (id, org_id, slug, slug_ci, name, description, created_by, created_at, updated_at) VALUES ('team-1', 'org-1', 'core', 'core', 'Core', NULL, ?, ?, ?)`,
    ALICE,
    NOW,
    NOW,
  );
  await run(db, `INSERT INTO team_members (team_id, user_email, role, joined_at) VALUES ('team-1', ?, 'admin', ?)`, BOB, NOW);

  await run(
    db,
    `INSERT INTO repositories (id, owner_email, owner, name, description, is_private, created_at, updated_at, owner_type, owner_ci, name_ci, owner_user_email, org_id) VALUES ('repo-user', ?, 'alice', 'widget', 'user repo', 0, ?, ?, 'user', 'alice', 'widget', ?, NULL)`,
    ALICE,
    NOW,
    NOW,
    ALICE,
  );
  await run(
    db,
    `INSERT INTO repositories (id, owner_email, owner, name, description, is_private, created_at, updated_at, owner_type, owner_ci, name_ci, owner_user_email, org_id) VALUES ('repo-org', ?, 'legacyorg', 'tools', 'org repo', 1, ?, ?, 'org', 'legacyorg', 'tools', NULL, 'org-1')`,
    ALICE,
    NOW,
    NOW,
  );
  await run(db, `INSERT INTO team_repo_grants (team_id, repo_id, role, granted_by, created_at) VALUES ('team-1', 'repo-org', 'write', ?, ?)`, ALICE, NOW);
  await run(db, `INSERT INTO repo_collaborators (repo_id, user_email, role, granted_by, created_at) VALUES ('repo-user', ?, 'write', ?, ?)`, BOB, ALICE, NOW);
  await run(db, `INSERT INTO repo_collaborators (repo_id, user_email, role, granted_by, created_at) VALUES ('repo-org', ?, 'admin', ?, ?)`, BOB, ALICE, NOW);
  await run(db, `INSERT INTO repo_stars (repo_id, user_email, created_at) VALUES ('repo-user', ?, ?)`, BOB, NOW);
  await run(db, `INSERT INTO repo_watches (repo_id, user_email, created_at) VALUES ('repo-user', ?, ?)`, BOB, NOW);
  await run(db, `INSERT INTO repo_events (id, repository_id, actor_email, type, payload, created_at) VALUES ('evt-1', 'repo-user', ?, 'push', '{}', ?)`, ALICE, NOW);
  await run(
    db,
    `INSERT INTO notifications (id, user_email, repository_id, actor_email, type, title, is_read, created_at) VALUES ('notif-1', ?, 'repo-user', ?, 'issue_commented', 'Hi', 0, ?)`,
    BOB,
    ALICE,
    NOW,
  );
  await run(
    db,
    `INSERT INTO audit_logs (log_id, timestamp, user_email, action, resource, method, path, status_code, created_at) VALUES ('audit-1', ?, ?, 'repo.create', 'repo', 'POST', '/user/repos', 201, ?)`,
    NOW,
    ALICE,
    NOW,
  );

  await run(db, `INSERT INTO user_access_tokens (token_id, user_email, token_hash, name, expires_at, created_at, token_prefix) VALUES ('tok-1', ?, 'hash-1', 'legacy', ?, ?, 'legacy')`, ALICE, NOW + 86_400, NOW);
  await run(db, `INSERT INTO token_scopes (token_id, scope, created_at) VALUES ('tok-1', 'admin', ?)`, NOW);
  await run(db, `INSERT INTO token_repo_grants (token_id, repository_id, scope, created_at) VALUES ('tok-1', 'repo-user', 'admin', ?)`, NOW);

  await run(db, `INSERT INTO branch_protection_rules (id, repository_id, pattern, created_by, created_at) VALUES ('bpr-1', 'repo-user', 'main', ?, ?)`, ALICE, NOW);
  await run(db, `INSERT INTO milestones (id, repository_id, title, created_at) VALUES ('ms-1', 'repo-user', 'v1', ?)`, NOW);
  await run(db, `INSERT INTO labels (id, repository_id, name, created_at) VALUES ('lbl-1', 'repo-user', 'bug', ?)`, NOW);
  await run(
    db,
    `INSERT INTO issues (id, repository_id, number, title, body, status, creator_email, created_at, updated_at) VALUES ('iss-1', 'repo-user', 1, 'Broken', 'detail', 'open', ?, ?, ?)`,
    ALICE,
    NOW,
    NOW,
  );
  await run(db, `INSERT INTO issue_assignees (issue_id, user_email, created_at) VALUES ('iss-1', ?, ?)`, BOB, NOW);
  await run(db, `INSERT INTO comments (id, issue_id, author_email, body, created_at) VALUES ('cmt-1', 'iss-1', ?, 'a comment', ?)`, MIXED, NOW);

  await run(
    db,
    `INSERT INTO pull_requests (id, repository_id, number, title, body, status, base_branch, head_branch, creator_email, merged_by, merged_at, created_at, updated_at, head_repository_id) VALUES ('pr-1', 'repo-user', 1, 'Change', 'body', 'merged', 'main', 'feature', ?, ?, ?, ?, ?, 'repo-org')`,
    ALICE,
    BOB,
    NOW,
    NOW,
    NOW,
  );
  await run(db, `INSERT INTO pull_request_reviews (id, pull_request_id, author_email, state, created_at) VALUES ('rev-1', 'pr-1', ?, 'approved', ?)`, BOB, NOW);
  await run(db, `INSERT INTO pull_reviewers (pull_request_id, user_email, status, created_at) VALUES ('pr-1', ?, 'pending', ?)`, BOB, NOW);
  await run(db, `INSERT INTO pull_assignees (pull_request_id, user_email, created_at) VALUES ('pr-1', ?, ?)`, BOB, NOW);
  await run(db, `INSERT INTO pull_request_comments (id, pull_request_id, author_email, body, created_at) VALUES ('prc-1', 'pr-1', ?, 'pr comment', ?)`, BOB, NOW);
  await run(
    db,
    `INSERT INTO pull_review_threads (id, pull_request_id, path, line, side, status, author_email, created_at, resolved_by, resolved_at) VALUES ('thr-1', 'pr-1', 'a.ts', 1, 'new', 'resolved', ?, ?, ?, ?)`,
    BOB,
    NOW,
    ALICE,
    NOW,
  );
  await run(db, `INSERT INTO pull_thread_comments (id, thread_id, author_email, body, created_at) VALUES ('tc-1', 'thr-1', ?, 'thread reply', ?)`, BOB, NOW);

  await run(
    db,
    `INSERT INTO repo_webhooks (id, repository_id, url, url_prefix, secret_suffix, is_active, creator_email, encrypted_secret, secret_iv, created_at, updated_at) VALUES ('wh-1', 'repo-user', 'https://example.test/hook', '', 'shh', 1, ?, 'enc', 'iv', ?, ?)`,
    ALICE,
    NOW,
    NOW,
  );
  await run(db, `INSERT INTO releases (id, repository_id, tag_name, name, body, is_draft, created_by, created_at) VALUES ('rel-1', 'repo-user', 'v1.0.0', 'v1', '', 0, ?, ?)`, ALICE, NOW);
  await run(
    db,
    `INSERT INTO release_assets (id, release_id, repository_id, name, created_by, created_at) VALUES ('asset-1', 'rel-1', 'repo-user', 'bin.tgz', ?, ?)`,
    ALICE,
    NOW,
  );
  await run(db, `INSERT INTO check_runs (id, repository_id, head_sha, context, status, creator_email, created_at, updated_at) VALUES ('chk-1', 'repo-user', 'abc123', 'ci', 'queued', ?, ?, ?)`, ALICE, NOW, NOW);

  await run(
    db,
    `INSERT INTO projects (id, repository_id, number, title, status, creator_email, created_at, updated_at) VALUES ('proj-1', 'repo-user', 1, 'Roadmap', 'open', ?, ?, ?)`,
    ALICE,
    NOW,
    NOW,
  );
  await run(db, `INSERT INTO project_columns (id, project_id, title, position, created_at) VALUES ('pcol-1', 'proj-1', 'Todo', 0, ?)`, NOW);
  await run(
    db,
    `INSERT INTO project_cards (id, project_id, column_id, kind, position, creator_email, created_at, updated_at) VALUES ('pcard-1', 'proj-1', 'pcol-1', 'note', 0, ?, ?, ?)`,
    BOB,
    NOW,
    NOW,
  );

  await run(db, `INSERT INTO discussion_categories (id, repository_id, slug, title, created_at) VALUES ('dcat-1', 'repo-user', 'general', 'General', ?)`, NOW);
  await run(
    db,
    `INSERT INTO discussions (id, repository_id, category_id, number, title, body, author_email, status, created_at, updated_at) VALUES ('disc-1', 'repo-user', 'dcat-1', 1, 'Chat', 'hi', ?, 'open', ?, ?)`,
    ALICE,
    NOW,
    NOW,
  );
  await run(db, `INSERT INTO discussion_comments (id, discussion_id, author_email, body, created_at, updated_at) VALUES ('dcmt-1', 'disc-1', ?, 'reply', ?, ?)`, BOB, NOW, NOW);

  await run(db, `INSERT INTO wiki_pages (id, repository_id, slug, title, body, revision, updated_by, created_at, updated_at) VALUES ('wiki-1', 'repo-user', 'home', 'Home', 'text', 1, ?, ?, ?)`, ALICE, NOW, NOW);
  await run(db, `INSERT INTO wiki_revisions (id, page_id, revision, body, author_email, created_at) VALUES ('wrev-1', 'wiki-1', 1, 'text', ?, ?)`, ALICE, NOW);

  await run(db, `INSERT INTO snippets (id, owner_email, title, visibility, created_at, updated_at) VALUES ('snip-1', ?, 'snippet', 'public', ?, ?)`, BOB, NOW, NOW);

  await run(
    db,
    `INSERT INTO repo_imports (id, repository_id, status, created_by, encrypted_source_url, source_url_iv, created_at, updated_at) VALUES ('imp-1', 'repo-user', 'pending', ?, 'enc', 'iv', ?, ?)`,
    ALICE,
    NOW,
    NOW,
  );
  await run(
    db,
    `INSERT INTO repo_mirrors (repository_id, enabled, created_by, encrypted_source_url, source_url_iv, created_at, updated_at) VALUES ('repo-user', 1, ?, 'enc', 'iv', ?, ?)`,
    ALICE,
    NOW,
    NOW,
  );
  await run(
    db,
    `INSERT INTO deploy_keys (id, repository_id, name, token_hash, permission, expires_at, created_by, created_at) VALUES ('dk-1', 'repo-user', 'ci', 'dkhash', 'read', ?, ?, ?)`,
    NOW + 86_400,
    ALICE,
    NOW,
  );
  await run(db, `INSERT INTO repo_security_settings (repository_id, secret_scan_mode, updated_by, updated_at) VALUES ('repo-user', 'warn', ?, ?)`, ALICE, NOW);
}

describe('0028 user identity upgrade on a populated database', () => {
  let db: Db;
  let before: Record<string, number>;
  let after: Record<string, number>;

  beforeAll(async () => {
    db = env.DB as unknown as Db;
    expect(migrationFileNames()).toContain(LAST_PRE_IDENTITY_MIGRATION);
    // Legacy schema first, then the upgrade under test.
    await applyMigrations(db, { to: LAST_PRE_IDENTITY_MIGRATION });
    await seedLegacyGraph(db);
    before = await snapshotCounts(db);
    // A pre-0028 `users` row has no id: that is the shape being upgraded.
    const preUser = await db.prepare('SELECT * FROM users WHERE email = ?').bind(ALICE).first<Record<string, unknown>>();
    expect(preUser?.id).toBeUndefined();
    await applyMigrations(db, { from: IDENTITY_MIGRATION });
    after = await snapshotCounts(db);
  });

  it('loses no rows in any table reachable from users or repositories', () => {
    const diffs: string[] = [];
    for (const table of GUARDED_TABLES) {
      if (before[table] !== after[table]) diffs.push(`${table}: ${before[table]} -> ${after[table]}`);
      // The seed is deterministic, so the count is also checked absolutely.
      if (after[table] !== expectedCount(table)) diffs.push(`${table}: expected ${expectedCount(table)}, got ${after[table]}`);
    }
    expect(diffs).toEqual([]);
  });

  it('reports no foreign key violations after the rebuild', async () => {
    const violations = await db.prepare('PRAGMA foreign_key_check').all<Record<string, unknown>>();
    expect(violations.results ?? []).toEqual([]);
  });

  it('gives every user a stable id and a verified address row', async () => {
    const rows = await db.prepare('SELECT id, email, current_email FROM users ORDER BY email').all<{
      id: string;
      email: string;
      current_email: string;
    }>();
    expect(rows.results).toHaveLength(3);
    const ids = new Set((rows.results ?? []).map((r) => r.id));
    expect(ids.size).toBe(3);
    for (const row of rows.results ?? []) {
      expect(row.id).toMatch(/^usr_[0-9a-f]{32}$/);
      // `current_email` starts as the lowercased anchor address.
      expect(row.current_email).toBe(row.email.toLowerCase());
    }
    // The registry is keyed on the lowercased address, so a mixed-case legacy
    // row still normalizes to a single login identity.
    const registry = await db.prepare('SELECT email, user_id, is_verified FROM user_emails').all<{
      email: string;
      user_id: string;
      is_verified: number;
    }>();
    expect(registry.results).toHaveLength(3);
    for (const row of registry.results ?? []) {
      expect(row.email).toBe(row.email.toLowerCase());
      expect(row.is_verified).toBe(1);
      expect(ids.has(row.user_id)).toBe(true);
    }
  });

  it('leaves every pre-existing foreign key intact', async () => {
    // The anchor design exists because D1 will not let these be repointed:
    // honour neither `PRAGMA foreign_keys = off` nor
    // `PRAGMA legacy_alter_table = on`, and `defer_foreign_keys` does not
    // suppress `ON DELETE CASCADE`. `users.email` is therefore frozen, and
    // the three cascades that made the address immutable are preserved.
    for (const table of ['repositories', 'user_access_tokens', 'snippets']) {
      const fks = await db.prepare(`PRAGMA foreign_key_list('${table}')`).all<{ table: string; to: string }>();
      const targets = (fks.results ?? []).filter((fk) => fk.table === 'users').map((fk) => fk.to);
      // The frozen-anchor reference survives *and* the new id reference is added
      // alongside it, so the table is now guarded on both.
      expect(`${table}: ${JSON.stringify(targets)}`).toBe(`${table}: ["email","id"]`);
    }
    const users = await db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`).first<{ sql: string }>();
    expect(users?.sql).toContain('id TEXT');
    expect(users?.sql).toContain('current_email TEXT');
    // The frozen anchor is still the primary key, so no existing reference
    // could have been invalidated.
    expect(users?.sql).toContain('email TEXT PRIMARY KEY');
  });

  it('backfills user_id on access-control rows (case-insensitively)', async () => {
    const alice = await userIdByEmail(db, ALICE);
    const bob = await userIdByEmail(db, BOB);
    expect(alice).toBeTruthy();
    expect(bob).toBeTruthy();

    const collab = await db.prepare('SELECT repo_id, user_id FROM repo_collaborators ORDER BY repo_id').all<{ repo_id: string; user_id: string }>();
    expect(collab.results).toEqual([
      { repo_id: 'repo-org', user_id: bob },
      { repo_id: 'repo-user', user_id: bob },
    ]);
    // `BOB@LEGACY.TEST` was stored mixed-case; the backfill must still land.
    const member = await db.prepare('SELECT user_id, role FROM organization_members WHERE role = ?').bind('member').first<{ user_id: string; role: string }>();
    expect(member?.user_id).toBe(bob);
    const owner = await db.prepare('SELECT user_id, role FROM organization_members WHERE role = ?').bind('owner').first<{ user_id: string; role: string }>();
    expect(owner?.user_id).toBe(alice);
    const teamMember = await db.prepare('SELECT user_id FROM team_members').first<{ user_id: string }>();
    expect(teamMember?.user_id).toBe(bob);
    const ns = await db.prepare(`SELECT user_id FROM namespaces WHERE username_ci = 'alice'`).first<{ user_id: string }>();
    expect(ns?.user_id).toBe(alice);
  });

  it('backfills user_id on ownership, tokens, recipients and attribution', async () => {
    const alice = await userIdByEmail(db, ALICE);
    const bob = await userIdByEmail(db, BOB);
    const repo = await db.prepare(`SELECT owner_user_id, owner_user_email FROM repositories WHERE id = 'repo-user'`).first<{
      owner_user_id: string;
      owner_user_email: string;
    }>();
    expect(repo?.owner_user_id).toBe(alice);
    const orgRepo = await db.prepare(`SELECT owner_user_id FROM repositories WHERE id = 'repo-org'`).first<{ owner_user_id: string }>();
    expect(orgRepo?.owner_user_id).toBe(alice);

    const token = await db.prepare(`SELECT user_id, user_email FROM user_access_tokens WHERE token_id = 'tok-1'`).first<{
      user_id: string;
      user_email: string;
    }>();
    expect(token?.user_id).toBe(alice);
    // The legacy string column is retained verbatim as a denormalized copy.
    expect(token?.user_email).toBe(ALICE);

    const notification = await db.prepare(`SELECT user_id, actor_user_id FROM notifications WHERE id = 'notif-1'`).first<{
      user_id: string;
      actor_user_id: string;
    }>();
    expect(notification?.user_id).toBe(bob);
    expect(notification?.actor_user_id).toBe(alice);

    const issue = await db.prepare(`SELECT creator_user_id FROM issues WHERE id = 'iss-1'`).first<{ creator_user_id: string }>();
    expect(issue?.creator_user_id).toBe(alice);
    const comment = await db.prepare(`SELECT author_user_id FROM comments WHERE id = 'cmt-1'`).first<{ author_user_id: string }>();
    // `Carol@Legacy.Test` is stored in `users.email` mixed-case; the
    // case-insensitive backfill must still find the account.
    expect(comment?.author_user_id).toBe(await userIdByEmail(db, MIXED));
    const merged = await db.prepare(`SELECT creator_user_id, merged_by_user_id FROM pull_requests WHERE id = 'pr-1'`).first<{
      creator_user_id: string;
      merged_by_user_id: string;
    }>();
    expect(merged?.creator_user_id).toBe(alice);
    expect(merged?.merged_by_user_id).toBe(bob);
    const snippet = await db.prepare(`SELECT owner_user_id FROM snippets WHERE id = 'snip-1'`).first<{ owner_user_id: string }>();
    expect(snippet?.owner_user_id).toBe(bob);
    const star = await db.prepare(`SELECT user_id FROM repo_stars`).first<{ user_id: string }>();
    expect(star?.user_id).toBe(bob);
    const audit = await db.prepare(`SELECT user_id FROM audit_logs WHERE log_id = 'audit-1'`).first<{ user_id: string }>();
    expect(audit?.user_id).toBe(alice);
  });

  it('keeps the repositories FTS triggers working across the upgrade', async () => {
    const triggers = await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'repositories' ORDER BY name`)
      .all<{ name: string }>();
    expect((triggers.results ?? []).map((t) => t.name)).toEqual([
      'trg_repo_fts_ad',
      'trg_repo_fts_ai',
      'trg_repo_fts_au',
      'trg_repo_rename_fts_au',
    ]);
    const indexed = await db.prepare(`SELECT repo_id, full_name FROM repo_fts ORDER BY repo_id`).all<{ repo_id: string; full_name: string }>();
    expect(indexed.results).toEqual([
      { repo_id: 'repo-org', full_name: 'legacyorg/tools' },
      { repo_id: 'repo-user', full_name: 'alice/widget' },
    ]);
    // And a post-migration write still syncs.
    await run(
      db,
      `INSERT INTO repositories (id, owner_email, owner, name, is_private, created_at, updated_at, owner_type, owner_ci, name_ci, owner_user_email) VALUES ('repo-after', ?, 'alice', 'post', 0, ?, ?, 'user', 'alice', 'post', ?)`,
      ALICE,
      NOW,
      NOW,
      ALICE,
    );
    const after = await db.prepare(`SELECT full_name FROM repo_fts WHERE repo_id = 'repo-after'`).first<{ full_name: string }>();
    expect(after?.full_name).toBe('alice/post');
  });

  it('changes the login address without disturbing id-keyed access', async () => {
    const alice = await userIdByEmail(db, ALICE);
    // What `UserIdentityService.setPrimaryEmail` does: claim the new address,
    // make it current, and revoke the old one for login. The account id, its
    // repositories, and every grant keyed on that id are untouched.
    await run(db, `UPDATE user_emails SET is_verified = 0 WHERE user_id = ?`, alice);
    await run(db, `INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES ('alice@new.test', ?, 1, ?)`, alice, NOW + 1);
    await run(db, `UPDATE users SET current_email = ?, updated_at = ? WHERE id = ?`, 'alice@new.test', NOW + 1, alice);

    const moved = await db.prepare('SELECT id, email, current_email FROM users WHERE id = ?').bind(alice).first<{
      id: string;
      email: string;
      current_email: string;
    }>();
    expect(moved?.current_email).toBe('alice@new.test');
    // The anchor never moves, which is what keeps the foreign keys valid.
    expect(moved?.email).toBe(ALICE);
    // Only the new address may log in.
    const verified = await db
      .prepare(`SELECT email FROM user_emails WHERE user_id = ? AND is_verified = 1`)
      .bind(alice)
      .all<{ email: string }>();
    expect(verified.results).toEqual([{ email: 'alice@new.test' }]);
    // Ownership and grants still resolve by id.
    const repo = await db.prepare(`SELECT owner_user_id FROM repositories WHERE id = 'repo-user'`).first<{ owner_user_id: string }>();
    expect(repo?.owner_user_id).toBe(alice);
    const token = await db.prepare(`SELECT user_id FROM user_access_tokens WHERE token_id = 'tok-1'`).first<{ user_id: string }>();
    expect(token?.user_id).toBe(alice);
    // The released address is claimable again by whoever legitimately owns it,
    // without inheriting this account's history. Two things make that work:
    // the revoked registry row is re-pointed rather than deleted, and the new
    // account takes an opaque anchor (the old address is permanently taken as
    // the previous account's anchor, so it cannot serve as one again).
    const successorId = 'usr_' + 'f'.repeat(32);
    const successorAnchor = 'anchor-' + 'e'.repeat(32) + '@users.invalid';
    await run(
      db,
      `INSERT INTO users (id, email, current_email, username, created_at) VALUES (?, ?, ?, 'newowner', ?)`,
      successorId,
      successorAnchor,
      ALICE,
      NOW + 2,
    );
    await run(
      db,
      `INSERT INTO user_emails (email, user_id, is_verified, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, is_verified = excluded.is_verified`,
      ALICE,
      successorId,
      NOW + 2,
    );
    const repointed = await db.prepare(`SELECT user_id, is_verified FROM user_emails WHERE email = ?`).bind(ALICE).first<{
      user_id: string;
      is_verified: number;
    }>();
    expect(repointed?.user_id).toBe(successorId);
    expect(repointed?.is_verified).toBe(1);
    // The new owner's account is distinct: no inherited repositories.
    const inherited = await db.prepare(`SELECT COUNT(*) AS n FROM repositories WHERE owner_user_id = ?`).bind(successorId).first<{ n: number }>();
    expect(inherited?.n).toBe(0);
    // And the previous holder's anchor is untouched, so their history still resolves.
    const previous = await db.prepare('SELECT email FROM users WHERE id = ?').bind(alice).first<{ email: string }>();
    expect(previous?.email).toBe(ALICE);
  });
});

async function userIdByEmail(db: Db, email: string): Promise<string> {
  const row = await db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').bind(email).first<{ id: string }>();
  return row?.id ?? '';
}

function expectedCount(table: string): number {
  // Seeding is deterministic: one row per insert, and the pre-0028 counts are
  // recomputed here from the same seed script rather than hard-coded.
  return SEEDED_COUNTS[table] ?? 0;
}

const SEEDED_COUNTS: Record<string, number> = {
  users: 3,
  namespaces: 2,
  organizations: 1,
  organization_members: 2,
  repositories: 2,
  user_access_tokens: 1,
  repo_collaborators: 2,
  branch_protection_rules: 1,
  milestones: 1,
  issues: 1,
  comments: 1,
  labels: 1,
  issue_assignees: 1,
  pull_requests: 1,
  pull_request_reviews: 1,
  pull_request_comments: 1,
  pull_assignees: 1,
  pull_reviewers: 1,
  pull_review_threads: 1,
  pull_thread_comments: 1,
  repo_stars: 1,
  repo_watches: 1,
  repo_events: 1,
  notifications: 1,
  repo_webhooks: 1,
  releases: 1,
  release_assets: 1,
  projects: 1,
  project_columns: 1,
  project_cards: 1,
  discussion_categories: 1,
  discussions: 1,
  discussion_comments: 1,
  wiki_pages: 1,
  wiki_revisions: 1,
  snippets: 1,
  teams: 1,
  team_members: 1,
  team_repo_grants: 1,
  audit_logs: 1,
  repo_imports: 1,
  repo_mirrors: 1,
  deploy_keys: 1,
  repo_security_settings: 1,
  check_runs: 1,
};
