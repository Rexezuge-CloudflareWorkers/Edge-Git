import { applyMigrations } from './migrations';

/**
 * Shared setup for integration tests (real D1 via `SELF.fetch`).
 *
 * Centralizes the `beforeAll` boilerplate for
 * `test/integration/api/*.int.test.ts`: migrations, user seeding, and direct
 * D1 repo seeding. Auth is `DEV_AUTH_EMAIL`-based (`test@example.com` in
 * `wrangler.test.jsonc`), so `/user/*` requests need no per-request
 * credentials. Git (`/:owner/:repo/info/refs|git-*-pack`) and public
 * (`/repos/*`) routes additionally accept PAT Bearer/Basic and deploy keys,
 * which the helpers below mint for second users (the DEV user can mint its
 * own PATs via `POST /user/tokens`).
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
  await db.prepare(`INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)`).bind(normalizedEmail, now).run();
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
  input: {
    ownerEmail: string;
    owner: string;
    name: string;
    isPrivate?: boolean;
    description?: string | null;
    ownerType?: string;
    orgId?: string | null;
  },
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

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mint a PAT row directly for any seeded user (including non-DEV second
 * users that cannot use `POST /user/tokens`, which always acts as DEV).
 * Returns the raw token for `Authorization: Bearer` / Basic use.
 * Scopes default to full access; pass explicit subsets to test scope gates.
 * Scopes live only in `token_scopes` (0024 dropped the JSON column).
 */
export async function mintPatForEmail(
  db: D1Database,
  email: string,
  input: { name?: string; scopes?: string[]; expiresInDays?: number } = {},
): Promise<{ tokenId: string; token: string }> {
  const normalized = email.toLowerCase();
  await ensureUser(db, normalized);
  const tokenId = crypto.randomUUID();
  const raw = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const tokenHash = await sha256Hex(`edge-git-pat:${raw}`);
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + (input.expiresInDays ?? 90) * 86_400;
  const scopes = input.scopes ?? ['repo:read', 'repo:write', 'admin'];
  await db
    .prepare(
      `INSERT INTO user_access_tokens (token_id, user_email, token_hash, name, expires_at, last_used_at, created_at, token_prefix) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(tokenId, normalized, tokenHash, input.name ?? 'test-token', expiresAt, now, raw.slice(0, 12))
    .run();
  for (const scope of scopes) {
    await db.prepare(`INSERT OR IGNORE INTO token_scopes (token_id, scope, created_at) VALUES (?, ?, ?)`).bind(tokenId, scope, now).run();
  }
  return { tokenId, token: raw };
}

export function bearerHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function basicAuthHeader(username: string, password: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`${username}:${password}`)}` };
}

export async function addCollaborator(
  db: D1Database,
  repoId: string,
  userEmail: string,
  role: 'admin' | 'write' | 'read',
  grantedBy?: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await ensureUser(db, userEmail);
  await db
    .prepare(`INSERT OR REPLACE INTO repo_collaborators (repo_id, user_email, role, granted_by, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(repoId, userEmail.toLowerCase(), role, grantedBy?.toLowerCase() ?? null, now)
    .run();
}
