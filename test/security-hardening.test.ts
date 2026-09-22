import { describe, expect, it } from 'vitest';
import { AccessAuthService } from '@edge-git/backend-services/auth';
import { AppConfiguration } from '@edge-git/backend-runtime/config/AppConfiguration';
import { ConfigurationManager } from '@edge-git/backend-runtime/config/ConfigurationManager';
import { TokenService } from '@edge-git/backend-services/auth';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { IssueService } from '@edge-git/backend-services/issue/IssueService';
import { validateWebhookUrl, verifyDeliverySignature, signDelivery } from '@edge-git/backend-services/webhook/WebhookEvents';
import { normalizePublicGitUrl, getBasicCredentials, getBearerToken, validateFilterSpec } from '@edge-git/git-protocol';
import { RepoFullName } from '@edge-git/shared/utils/Identity';
import { isSafeFilePath } from '@/workers/routes/FileWriteRoutes';
import { rateLimit, resetRateLimitForTests, SECURITY_HEADERS } from '@/middleware';

function createTokenFakeDb() {
  const tokens: Array<Record<string, unknown>> = [];
  const tokenScopes: Array<{ token_id: string; scope: string }> = [];
  const repos: Array<Record<string, unknown>> = [
    { id: 'r1', owner: 'alice', name: 'repo', owner_email: 'alice@example.com', is_private: 0 },
  ];
  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.startsWith('SELECT * FROM user_access_tokens WHERE token_hash = ?')) {
          const row = tokens.find((t) => t.token_hash === params[0] && (t.expires_at as number) > (params[1] as number));
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.includes('FROM repositories WHERE owner_ci = ? AND name_ci = ?')) {
          const row = repos.find(
            (r) =>
              String(r.owner_ci ?? r.owner).toLowerCase() === String(params[0]).toLowerCase() &&
              String(r.name_ci ?? r.name).toLowerCase() === String(params[1]).toLowerCase(),
          );
          return Promise.resolve((row ?? null) as T | null);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.includes('FROM user_access_tokens WHERE')) {
          return Promise.resolve({
            results: tokens.filter((t) => String(t.user_email).toLowerCase() === String(params[0]).toLowerCase()) as T[],
          });
        }
        if (q.startsWith('SELECT scope FROM token_scopes WHERE token_id = ?')) {
          const rows = tokenScopes.filter((s) => s.token_id === params[0]).map((s) => ({ scope: s.scope }));
          return Promise.resolve({ results: rows as T[] });
        }
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO user_access_tokens')) {
          const [token_id, user_email, token_hash, tname, expires_at, created_at, token_prefix] = params as Array<string | number>;
          tokens.push({
            token_id,
            user_email,
            token_hash,
            name: tname,
            expires_at,
            last_used_at: null,
            created_at,
            token_prefix: typeof token_prefix === 'string' ? token_prefix : null,
          });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM token_scopes WHERE token_id = ?')) {
          for (let i = tokenScopes.length - 1; i >= 0; i -= 1) {
            if (tokenScopes[i].token_id === params[0]) tokenScopes.splice(i, 1);
          }
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('INSERT OR IGNORE INTO token_scopes')) {
          const [token_id, scope] = params as [string, string];
          if (!tokenScopes.some((s) => s.token_id === token_id && s.scope === scope)) tokenScopes.push({ token_id, scope });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('UPDATE user_access_tokens SET last_used_at')) {
          const row = tokens.find((t) => t.token_hash === params[1]);
          if (row) row.last_used_at = params[0];
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      },
    };
  }
  const db = { prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) };
  return { db: db as unknown as D1Queryable, tokens };
}

function createIssueFakeDb() {
  const issues: Array<Record<string, unknown>> = [];
  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.includes('COALESCE(MAX(number)')) {
          const max = issues.filter((i) => i.repository_id === params[0]).reduce((m, i) => Math.max(m, i.number as number), 0);
          return Promise.resolve({ max_n: max } as unknown as T);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean }> {
        if (q.startsWith('INSERT INTO issues')) {
          const [id, repository_id, number, title, body] = params as Array<string | number | null>;
          issues.push({ id, repository_id, number, title, body });
          return Promise.resolve({ success: true });
        }
        return Promise.resolve({ success: true });
      },
    };
  }
  return { prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }) } as unknown as D1Queryable;
}

describe('auth bypass hardening', () => {
  it('defaults ENVIRONMENT to production (secure by default) and denies bypass', () => {
    expect(ConfigurationManager.auth.getEnvironment({})).toBe('production');
    expect(ConfigurationManager.auth.isBypassAllowed({})).toBe(false);
    expect(AppConfiguration.fromEnv({}).isBypassAllowed()).toBe(false);
  });

  it('allows bypass only when ENVIRONMENT is explicitly non-production', async () => {
    const dev = { ENVIRONMENT: 'development', DEV_AUTH_EMAIL: 'dev@example.com' };
    expect(ConfigurationManager.auth.isBypassAllowed(dev)).toBe(true);
    const svc = new AccessAuthService(dev);
    await expect(svc.getAuthenticatedUserEmail(new Request('https://example.com/'))).resolves.toBe('dev@example.com');
  });

  it('disables DEMO/DEV bypass in production even when vars are set', async () => {
    const prod = { ENVIRONMENT: 'production', DEMO_MODE: 'true', DEV_AUTH_EMAIL: 'dev@example.com' };
    expect(ConfigurationManager.auth.isBypassAllowed(prod)).toBe(false);
    const svc = new AccessAuthService(prod);
    await expect(
      svc.getAuthenticatedUserEmail(new Request('https://example.com/'), {
        access: { getIdentity: async () => ({ email: 'prod@example.com' }) },
      }),
    ).resolves.toBe('prod@example.com');
  });

  it('normalizes DEV email and rejects malformed bypass values', async () => {
    const upper = new AccessAuthService({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: '  DEV@Example.COM  ' });
    await expect(upper.getAuthenticatedUserEmail(new Request('https://example.com/'))).resolves.toBe('dev@example.com');
    for (const bad of ['not-an-email', 'a b@c.com', 'x'.repeat(300) + '@example.com']) {
      const svc = new AccessAuthService({ ENVIRONMENT: 'development', DEV_AUTH_EMAIL: bad });
      await expect(svc.getAuthenticatedUserEmail(new Request('https://example.com/'))).rejects.toThrow();
    }
  });

  it('returns a generic JWT failure without leaking verifier details', async () => {
    const svc = new AccessAuthService({ TEAM_DOMAIN: 'https://team.example.com', POLICY_AUD: 'aud' });
    const req = new Request('https://example.com/', { headers: { 'cf-access-jwt-assertion': 'invalid.token.here' } });
    const err = await svc.getAuthenticatedUserEmail(req).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Cloudflare Access authentication failed.');
    expect((err as Error).message).not.toContain('invalid');
  });
});

describe('token hardening', () => {
  it('rejects zero/negative/non-integer/string expiry and trims/caps names', async () => {
    const { db } = createTokenFakeDb();
    const svc = new TokenService({ DB: db });
    for (const bad of [0, -1, Number.NaN, 1.5, 'abc' as unknown as number]) {
      await expect(svc.createToken('a@example.com', 't', bad, ['repo:read'])).rejects.toThrow('expiresInDays must be a positive integer');
    }
    await expect(svc.createToken('a@example.com', 't', 9999, ['repo:read'])).rejects.toThrow('cannot exceed');
    await expect(svc.createToken('a@example.com', '   ', undefined, ['repo:read'])).rejects.toThrow('name is required');
    await expect(svc.createToken('a@example.com', 'x'.repeat(101), undefined, ['repo:read'])).rejects.toThrow('at most 100');
    const created = await svc.createToken('a@example.com', '  spaced  ', undefined, ['repo:read']);
    expect(created.name).toBe('spaced');
  });

  it('hides private repo existence in scoped-grant errors', async () => {
    const { db } = createTokenFakeDb();
    const svc = new TokenService({ DB: db });
    await expect(
      svc.createToken('a@example.com', 't', undefined, ['repo:read'], [{ owner: 'ghost', name: 'missing', scope: 'repo:read' }]),
    ).rejects.toThrow('Repository not found');
    try {
      await svc.createToken('a@example.com', 't', undefined, ['repo:read'], [{ owner: 'ghost', name: 'missing', scope: 'repo:read' }]);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('ghost/missing');
    }
  });
});

describe('issue validation hardening', () => {
  it('enforces title/body caps matching PR limits', async () => {
    const svc = new IssueService({ DB: createIssueFakeDb() });
    await expect(svc.createIssue({ repositoryId: 'r', fullName: 'a/b', title: '   ', creatorEmail: 'a@x.com' })).rejects.toThrow(
      'title is required',
    );
    await expect(svc.createIssue({ repositoryId: 'r', fullName: 'a/b', title: 'x'.repeat(201), creatorEmail: 'a@x.com' })).rejects.toThrow(
      'at most 200',
    );
    await expect(
      svc.createIssue({ repositoryId: 'r', fullName: 'a/b', title: 'ok', body: 'y'.repeat(10_001), creatorEmail: 'a@x.com' }),
    ).rejects.toThrow('at most 10000');
    await expect(
      svc.createIssue({ repositoryId: 'r', fullName: 'a/b', title: '  hello  ', creatorEmail: 'a@x.com' }),
    ).resolves.toMatchObject({});
  });
});

describe('SSRF guard hardening', () => {
  it('rejects encoded, IPv6-private, and malformed hosts for webhooks', () => {
    for (const bad of [
      'https://[fc00::1]/hook',
      'https://[fd00::1]/hook',
      'https://[fe80::1]/hook',
      'https://[ff02::1]/hook',
      'https://[::ffff:127.0.0.1]/hook',
      'https://2130706433/hook',
      'https://0x7f000001/hook',
      'https://0x7f.0x0.0x0.0x1/hook',
      'https://0177.0.0.1/hook',
      'https://localhost./hook',
      'https://bad_host.example.com/hook',
      'https://[::]/hook',
    ]) {
      expect(() => validateWebhookUrl(bad), bad).toThrow();
    }
    expect(() => validateWebhookUrl('https://hooks.example.com/edge-git')).not.toThrow();
  });

  it('rejects the same classes for git import URLs', () => {
    for (const bad of [
      'https://[fc00::1]/o/r',
      'https://2130706433/o/r',
      'https://0x7f000001/o/r',
      'https://localhost./o/r',
      'https://bad_host.example.com/o/r',
    ]) {
      expect(() => normalizePublicGitUrl(bad), bad).toThrow();
    }
    expect(normalizePublicGitUrl('https://github.com/owner/repo')).toBe('https://github.com/owner/repo');
  });

  it('verifies webhook signatures in constant time', async () => {
    const sig = await signDelivery('secret', 'body');
    await expect(verifyDeliverySignature('secret', 'body', sig)).resolves.toBe(true);
    await expect(verifyDeliverySignature('secret', 'body', sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0'))).resolves.toBe(false);
    await expect(verifyDeliverySignature('secret', 'body', 'short')).resolves.toBe(false);
  });
});

describe('protocol caps', () => {
  it('caps Authorization header length', () => {
    const long = `Bearer ${'x'.repeat(9000)}`;
    expect(getBearerToken(new Request('https://x/', { headers: { Authorization: long } }))).toBeNull();
    expect(getBasicCredentials(new Request('https://x/', { headers: { Authorization: `Basic ${'y'.repeat(9000)}` } }))).toBeNull();
  });

  it('bounds blob:limit filters', () => {
    expect(validateFilterSpec('blob:limit=1024')).toBeNull();
    expect(validateFilterSpec('blob:limit=99999999999')).not.toBeNull();
    expect(validateFilterSpec('blob:limit=-1')).not.toBeNull();
  });
});

describe('identity and file-path guards', () => {
  it('rejects dot, traversal, and lock repo names', () => {
    for (const bad of ['.', '..', '.hidden', '-dash', 'a..b', 'repo.lock']) {
      expect(RepoFullName.tryParse('alice', bad)).toBeNull();
    }
    expect(RepoFullName.tryParse('alice', 'my-repo.js')).not.toBeNull();
  });

  it('rejects unsafe editor paths', () => {
    expect(isSafeFilePath('/abs/path')).toBe(false);
    expect(isSafeFilePath('../escape')).toBe(false);
    expect(isSafeFilePath('a//b')).toBe(false);
    expect(isSafeFilePath('a/./b')).toBe(false);
    expect(isSafeFilePath('src/index.ts')).toBe(true);
  });
});

describe('rate limit and security headers', () => {
  it('buckets per key and returns 429 with Retry-After', async () => {
    resetRateLimitForTests();
    const guard = rateLimit({ windowMs: 60_000, max: 2, keyPrefix: 'test-harness' });
    const calls: string[] = [];
    const next = async () => {
      calls.push('ok');
    };
    const makeCtx = () =>
      ({
        req: { header: () => null },
        get: () => {
          throw new Error('no scope');
        },
        json: (body: unknown, status: number, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers }),
      }) as never;
    expect(guard).toBeTypeOf('function');
    await guard(makeCtx(), next as never);
    await guard(makeCtx(), next as never);
    const limited = (await guard(makeCtx(), next as never)) as unknown as Response;
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    expect(calls).toHaveLength(2);
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
  });
});
