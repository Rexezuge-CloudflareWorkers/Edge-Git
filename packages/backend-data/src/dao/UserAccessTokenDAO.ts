import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';
import type { TokenScope, UserAccessTokenMetadata } from '@edge-git/shared';

export interface TokenRow {
  token_id: string;
  user_email: string;
  token_hash: string;
  name: string;
  expires_at: number;
  last_used_at: number | null;
  created_at: number;
  scopes?: string | null;
  token_prefix?: string | null;
}

function parseScopes(raw: string | null | undefined): TokenScope[] {
  // Fail closed: legacy NULL/invalid/empty scope rows grant nothing.
  // Previously these fell back to full access; that fail-open could
  // escalate a corrupt row to admin. New mints always serialize explicit
  // scopes, so empty here means deny.
  if (raw === null || raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter((s): s is TokenScope => typeof s === 'string' && (['repo:read', 'repo:write', 'admin'] as const).includes(s as TokenScope));
    return valid.length > 0 ? valid : [];
  } catch {
    return [];
  }
}

function toMetadata(row: TokenRow): UserAccessTokenMetadata {
  return {
    tokenId: row.token_id,
    userEmail: row.user_email,
    tokenHash: row.token_hash,
    name: row.name,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    scopes: parseScopes(row.scopes),
    tokenPrefix: row.token_prefix ?? null,
  };
}

class UserAccessTokenDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async create(
    tokenId: string,
    userEmail: string,
    tokenHash: string,
    name: string,
    expiresAt: number,
    now: number,
    scopes?: readonly TokenScope[] | null,
    tokenPrefix?: string | null,
  ): Promise<void> {
    const serialized = scopes && scopes.length > 0 ? JSON.stringify([...scopes]) : null;
    try {
      await this.withRetry(
        () =>
          this.database
            .prepare(
              'INSERT INTO user_access_tokens (token_id, user_email, token_hash, name, expires_at, last_used_at, created_at, scopes, token_prefix) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)',
            )
            .bind(tokenId, userEmail.toLowerCase(), tokenHash, name, expiresAt, now, serialized, tokenPrefix ?? null)
            .run(),
        'create access token',
      );
      return;
    } catch {
      // Fallback for DBs without the 0016 prefix column: retry with scopes.
    }
    if (serialized !== null) {
      try {
        await this.withRetry(
          () =>
            this.database
              .prepare(
                'INSERT INTO user_access_tokens (token_id, user_email, token_hash, name, expires_at, last_used_at, created_at, scopes) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)',
              )
              .bind(tokenId, userEmail.toLowerCase(), tokenHash, name, expiresAt, now, serialized)
              .run(),
          'create access token',
        );
        return;
      } catch {
        // Fallback for DBs without the 0007 scopes column: retry without it.
      }
    }
    await this.withRetry(
      () =>
        this.database
          .prepare(
            'INSERT INTO user_access_tokens (token_id, user_email, token_hash, name, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
          )
          .bind(tokenId, userEmail.toLowerCase(), tokenHash, name, expiresAt, now)
          .run(),
      'create access token',
    );
  }

  public async getByTokenHash(tokenHash: string, nowSeconds: number): Promise<UserAccessTokenMetadata | undefined> {
    const row = await this.database
      .prepare('SELECT * FROM user_access_tokens WHERE token_hash = ? AND expires_at > ? LIMIT 1')
      .bind(tokenHash, nowSeconds)
      .first<TokenRow>();
    return row ? toMetadata(row) : undefined;
  }

  public async getByUserEmail(userEmail: string): Promise<UserAccessTokenMetadata[]> {
    const result = await this.database
      .prepare('SELECT * FROM user_access_tokens WHERE lower(user_email) = lower(?) ORDER BY created_at DESC')
      .bind(userEmail)
      .all<TokenRow>();
    return (result.results ?? []).map(toMetadata);
  }

  public async updateLastUsedByHash(tokenHash: string, now: number): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('UPDATE user_access_tokens SET last_used_at = ? WHERE token_hash = ?').bind(now, tokenHash).run(),
      'update token last used',
    );
  }

  public async delete(tokenId: string, userEmail: string): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM user_access_tokens WHERE token_id = ? AND lower(user_email) = lower(?)').bind(tokenId, userEmail).run(),
      'delete access token',
    );
  }

  public async rotate(tokenId: string, userEmail: string, newHash: string, newPrefix: string, newExpiresAt: number): Promise<boolean> {
    const result = await this.withRetry(
      () =>
        this.database
          .prepare('UPDATE user_access_tokens SET token_hash = ?, token_prefix = ?, expires_at = ?, last_used_at = NULL WHERE token_id = ? AND lower(user_email) = lower(?)')
          .bind(newHash, newPrefix, newExpiresAt, tokenId, userEmail)
          .run(),
      'rotate access token',
    );
    return ((result.meta as { changes?: number })?.changes ?? 0) > 0;
  }

  public async pruneExpired(now: number, limit: number): Promise<number> {
    return this.deleteRowsOlderThan('user_access_tokens', 'expires_at', now, limit, 'token_id');
  }
}

export { UserAccessTokenDAO };
