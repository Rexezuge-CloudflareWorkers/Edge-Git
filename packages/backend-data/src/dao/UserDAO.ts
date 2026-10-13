import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '@rexezuge/d1';

/**
 * `users` rows.
 *
 * `id` is the stable account key. `email` is the *anchor*: an immutable,
 * internally unique value that legacy `*_email` columns and their foreign keys
 * point at, so history stays resolvable across an address change. Accounts
 * created before migration 0028 have their real address there; accounts created
 * after it get an opaque anchor (see `UserDAO.newAnchor`) because the address
 * is a mutable attribute held in `current_email` + `user_emails`.
 *
 * `current_email` is the address the account signs in with and the one the API
 * reports. It is NULL only on databases that have not run 0028.
 */
export interface UserRow {
  id?: string | null;
  email: string;
  current_email?: string | null;
  created_at: number;
  username: string | null;
  updated_at: number | null;
}

/**
Address a new account logs in with, preferring the mutable one.
*/
function loginEmailOf(row: UserRow | null): string | null {
  if (!row) return null;
  return (row.current_email ?? row.email).toLowerCase();
}

class UserDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  /**
   * Opaque anchor for accounts created after 0028.
   *
   * It must be globally unique and must never be a real address: the anchor
   * column is the primary key that every legacy `*_email` foreign key resolves
   * against, so an address used here could never be re-registered by a
   * different person after the original account changed addresses.
   */
  public static newAnchor(): string {
    const random = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `anchor-${random}@users.invalid`;
  }

  public static newId(): string {
    const random = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `usr_${random}`;
  }

  /**
   * Create an account under `input.anchor`.
   *
   * Returns the new account's id, or `null` when the insert was a silent no-op
   * because the anchor is already held. That `null` is what makes the caller's
   * retry with an opaque anchor safe: without it the retry would hand back an
   * id the database never stored, and the address registry would be pointed at a
   * phantom account that resolves to nothing.
   *
   * The no-op is established by reading the anchor row back and requiring *this*
   * insert's generated id to be the one there, not by inspecting `meta.changes`.
   * `ON CONFLICT DO NOTHING` reports neither form reliably — `changes` is absent
   * on some paths, and the named-target form only covers the constraints it
   * names — while the read-back is exactly the question being asked.
   *
   * `ON CONFLICT` without a target: `users` carries both the anchor primary key
   * and a unique index on `current_email`, and naming only the anchor would let a
   * `current_email` collision raise, which the caller cannot tell from a
   * transient D1 failure — it would propagate and the retry would never run.
   */
  public async createUser(input: { anchor: string; loginEmail: string; now: number }): Promise<string | null> {
    const id = UserDAO.newId();
    await this.run('INSERT INTO users (email, created_at, id, current_email) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [
      input.anchor,
      input.now,
      id,
      input.loginEmail,
    ]);
    const row = await this.getByEmail(input.anchor);
    return row?.id === id ? id : null;
  }

  /**
   * Pre-0028 insert path, kept for callers that only have an address. The
   * anchor is the address itself, matching the shape of rows already in the
   * database.
   */
  public async upsertUser(email: string, now: number): Promise<void> {
    await this.run('INSERT INTO users (email, created_at, id, current_email) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING', [email, now, UserDAO.newId(), email]);
  }

  public async ensureUsername(idOrEmail: string, username: string, now: number): Promise<void> {
    await this.run('UPDATE users SET username = COALESCE(username, ?), updated_at = COALESCE(updated_at, ?) WHERE id = ? OR email = ?', [username, now, idOrEmail, idOrEmail]);
  }

  public async setUsername(idOrEmail: string, username: string, now: number): Promise<void> {
    await this.run('UPDATE users SET username = ?, updated_at = ? WHERE id = ? OR email = ?', [username, now, idOrEmail, idOrEmail]);
  }

  /**
  Anchor lookup — used for legacy `*_email` values and cascade resolution.
  */
  public async getByEmail(email: string): Promise<UserRow | null> {
    return this.first<UserRow>('SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1', [email]);
  }

  public async getById(id: string): Promise<UserRow | null> {
    return this.first<UserRow>('SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  }

  public async getByCurrentEmail(email: string): Promise<UserRow | null> {
    return this.first<UserRow>('SELECT * FROM users WHERE lower(current_email) = lower(?) LIMIT 1', [email]);
  }

  public async getByUsernameCi(usernameCi: string): Promise<UserRow | null> {
    return this.first<UserRow>('SELECT * FROM users WHERE lower(username) = ? LIMIT 1', [usernameCi]);
  }

  /**
   * Move the login address. The anchor is deliberately untouched: it is what
   * every legacy `*_email` column and foreign key resolves against.
   */
  public async setCurrentEmail(id: string, email: string, now: number): Promise<void> {
    await this.run('UPDATE users SET current_email = ?, updated_at = ? WHERE id = ?', [email, now, id]);
  }

  public async getByEmails(emails: string[]): Promise<UserRow[]> {
    const keys = dedupe(emails);
    if (keys.length === 0) return [];
    return this.batchLookup(keys, 'email');
  }

  public async getByIds(ids: string[]): Promise<UserRow[]> {
    const keys = dedupe(ids);
    if (keys.length === 0) return [];
    return this.batchLookup(keys, 'id');
  }

  private async batchLookup(keys: string[], column: 'email' | 'id'): Promise<UserRow[]> {
    const out: UserRow[] = [];
    for (let i = 0; i < keys.length; i += 50) {
      const chunk = keys.slice(i, i + 50);
      const placeholders = chunk.map(() => '?').join(', ');
      const result = await this.database
        .prepare(`SELECT * FROM users WHERE lower(${column}) IN (${placeholders})`)
        .bind(...chunk)
        .all<UserRow>();
      const rows = result.results ?? [];
      for (const row of rows) out.push(row);
    }
    return out;
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

export { UserDAO, loginEmailOf };
