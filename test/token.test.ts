import { describe, expect, it } from 'vitest';
import { TokenService, coversScope, normalizeTokenScopes, parseTokenScopes } from '@edge-git/backend-services/auth';
import type { D1Queryable } from '@edge-git/backend-data/utils';

function createTokenFakeDb(): D1Queryable & { tokens: Array<Record<string, unknown>> } {
  const state = { tokens: [] as Array<Record<string, unknown>> };
  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.startsWith('SELECT * FROM user_access_tokens WHERE token_hash = ?')) {
          const row = state.tokens.find((t) => t.token_hash === params[0] && (t.expires_at as number) > (params[1] as number));
          return Promise.resolve((row ?? null) as T | null);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.startsWith('SELECT * FROM user_access_tokens WHERE')) {
          const rows = state.tokens.filter((t) => String(t.user_email).toLowerCase() === String(params[0]).toLowerCase());
          return Promise.resolve({ results: rows as T[] });
        }
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO user_access_tokens')) {
          const [token_id, user_email, token_hash, tname, expires_at, created_at, scopes] = params as Array<string | number>;
          state.tokens.push({
            token_id,
            user_email,
            token_hash,
            name: tname,
            expires_at,
            last_used_at: null,
            created_at,
            scopes: typeof scopes === 'string' ? scopes : null,
          });
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
  return {
    prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }),
    tokens: state.tokens,
  } as unknown as D1Queryable & {
    tokens: Array<Record<string, unknown>>;
  };
}

describe('TokenService hashing', () => {
  it('hashes deterministically and differs per token', async () => {
    const a = await TokenService.hashToken('abc');
    const b = await TokenService.hashToken('abc');
    const c = await TokenService.hashToken('abd');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('token scope helpers', () => {
  it('coversScope applies the admin > write > read hierarchy', () => {
    expect(coversScope(['repo:read'], 'repo:read')).toBe(true);
    expect(coversScope(['repo:read'], 'repo:write')).toBe(false);
    expect(coversScope(['repo:write'], 'repo:read')).toBe(true);
    expect(coversScope(['repo:write'], 'repo:write')).toBe(true);
    expect(coversScope(['repo:write'], 'admin')).toBe(false);
    expect(coversScope(['admin'], 'repo:read')).toBe(true);
    expect(coversScope(['admin'], 'repo:write')).toBe(true);
    expect(coversScope(['admin'], 'admin')).toBe(true);
    expect(coversScope([], 'repo:read')).toBe(false);
  });

  it('parseTokenScopes fails closed for legacy/invalid rows', () => {
    expect(parseTokenScopes(null)).toEqual([]);
    expect(parseTokenScopes(undefined)).toEqual([]);
    expect(parseTokenScopes('not-json')).toEqual([]);
    expect(parseTokenScopes('[]')).toEqual([]);
    expect(parseTokenScopes('["repo:read"]')).toEqual(['repo:read']);
    expect(parseTokenScopes('["repo:write","repo:read"]')).toEqual(['repo:read', 'repo:write']);
  });

  it('normalizeTokenScopes defaults omitted input and rejects bad input', () => {
    expect(normalizeTokenScopes(undefined)).toEqual(['repo:read', 'repo:write', 'admin']);
    expect(normalizeTokenScopes(null)).toEqual(['repo:read', 'repo:write', 'admin']);
    expect(normalizeTokenScopes(['repo:read'])).toEqual(['repo:read']);
    expect(() => normalizeTokenScopes([])).toThrow('scopes must be');
    expect(() => normalizeTokenScopes(['nope'])).toThrow('scopes must be');
    expect(() => normalizeTokenScopes(['repo:read', 'nope'])).toThrow('scopes must be');
    expect(() => normalizeTokenScopes('repo:read')).toThrow('scopes must be');
  });
});

describe('TokenService scoped lifecycle', () => {
  it('mints scoped tokens and returns scopes on authenticate', async () => {
    const db = createTokenFakeDb();
    const svc = new TokenService({ DB: db });
    const created = await svc.createToken('alice@example.com', 'reader', undefined, ['repo:read']);
    expect(created.scopes).toEqual(['repo:read']);
    const identity = await svc.authenticateWithPAT(created.token);
    expect(identity).toMatchObject({ email: 'alice@example.com', scopes: ['repo:read'] });
    expect(TokenService.coversScope(identity.scopes, 'repo:read')).toBe(true);
    expect(TokenService.coversScope(identity.scopes, 'repo:write')).toBe(false);
  });

  it('rejects invalid scopes at mint time', async () => {
    const db = createTokenFakeDb();
    const svc = new TokenService({ DB: db });
    await expect(svc.createToken('alice@example.com', 'bad', undefined, ['nope'])).rejects.toThrow('scopes must be');
  });

  it('denies legacy rows without scopes (fail-closed)', async () => {
    const db = createTokenFakeDb();
    db.tokens.push({
      token_id: 'legacy',
      user_email: 'legacy@example.com',
      token_hash: await TokenService.hashToken('legacy-token'),
      name: 'legacy',
      expires_at: 9_999_999_999,
      last_used_at: null,
      created_at: 1,
      scopes: null,
    });
    const svc = new TokenService({ DB: db });
    const identity = await svc.authenticateWithPAT('legacy-token');
    expect(identity.scopes).toEqual([]);
    expect(TokenService.coversScope(identity.scopes, 'repo:read')).toBe(false);
  });

  it('fails closed when repo grants cannot be read', async () => {
    const db = createTokenFakeDb();
    const svc = new TokenService({ DB: db });
    const created = await svc.createToken('alice@example.com', 'scoped', undefined, ['repo:read']);
    const failing = new TokenService(
      { DB: db },
      {
        tokenGrantDAO: () =>
          Promise.resolve({
            listByToken: () => Promise.reject(new Error('D1 unavailable')),
          } as never),
      },
    );
    await expect(failing.authenticateWithPAT(created.token)).rejects.toThrow('temporarily unavailable');
  });
});
