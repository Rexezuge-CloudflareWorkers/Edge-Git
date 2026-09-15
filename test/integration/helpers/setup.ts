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

export async function ensureUser(db: D1Database, email: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(`INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)`)
    .bind(email, now)
    .run();
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
  input: { ownerEmail: string; owner: string; name: string; isPrivate?: boolean; description?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await ensureUser(db, input.ownerEmail);
  await db
    .prepare(
      `INSERT OR IGNORE INTO repositories (id, owner_email, owner, name, description, is_private, created_at, updated_at) ` +
        `VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.ownerEmail, input.owner, input.name, input.description ?? null, input.isPrivate === true ? 1 : 0, now, now)
    .run();
  return id;
}
