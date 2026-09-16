import { applyMigrations } from './migrations';

/**
 * Shared setup for integration tests (real D1 via `SELF.fetch`).
 *
 * Centralizes the `beforeAll` boilerplate for
 * `test/integration/api/*.int.test.ts`: migrations, user seeding, and direct
 * D1 repo seeding. Auth is `DEV_AUTH_EMAIL`-based (`test@example.com` in
 * `wrangler.test.jsonc`), so no per-request credentials are needed.
 */

type TestEnv = Record<string, unknown> & { DB: D1Database };

export async function ensureAesSecret(_env: TestEnv): Promise<void> {
  // No Secrets Store binding exists in `wrangler.test.jsonc`: integration auth
  // is DEV-based and PAT hashing is sha256 (no encryption). Named step kept so
  // future encrypted-state tests have a single place to extend.
}

export async function ensureUser(db: D1Database, email: string, username?: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const normalizedEmail = email.toLowerCase();
  const handle = (username ?? normalizedEmail.split('@', 1)[0]).trim() || 'user';
  const handleCi = handle.toLowerCase();
  await db
    .prepare(`INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)`)
    .bind(normalizedEmail, now)
    .run();
  await db
    .prepare(`UPDATE users SET username = COALESCE(username, ?), updated_at = COALESCE(updated_at, ?) WHERE email = ?`)
    .bind(handle, now, normalizedEmail)
    .run();
  await db
    .prepare(`INSERT OR IGNORE INTO namespaces (username_ci, kind, user_email, org_id, created_at) VALUES (?, 'user', ?, NULL, ?)`)
    .bind(handleCi, normalizedEmail, now)
    .run();
  return handle;
}

export async function setupIntegrationTest(env: TestEnv, userEmail?: string): Promise<void> {
  await applyMigrations(env.DB);
  await ensureAesSecret(env);
  if (userEmail) {
    await ensureUser(env.DB, userEmail);
  }
}

export async function seedRepo(
  db: D1Database,
  input: { ownerEmail: string; owner: string; name: string; isPrivate?: boolean; description?: string | null; ownerType?: string; orgId?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const ownerUsername = await ensureUser(db, input.ownerEmail, input.owner);
  const ownerType = input.ownerType ?? 'user';
  await db
    .prepare(
      `INSERT OR IGNORE INTO repositories (id, owner_email, owner, name, description, is_private, created_at, updated_at, owner_type, owner_ci, name_ci, owner_user_email, org_id) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.ownerEmail.toLowerCase(),
      ownerUsername,
      input.name,
      input.description ?? null,
      input.isPrivate === true ? 1 : 0,
      now,
      now,
      ownerType,
      ownerUsername.toLowerCase(),
      input.name.toLowerCase(),
      ownerType === 'user' ? input.ownerEmail.toLowerCase() : null,
      input.orgId ?? null,
    )
    .run();
  return id;
}
