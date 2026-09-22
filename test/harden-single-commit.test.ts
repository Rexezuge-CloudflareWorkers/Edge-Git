import { describe, expect, it } from 'vitest';
import { BaseRoute } from '@/endpoints/IBaseRoute';
import { Container, createServiceContext, setRequestScope, getRequestScope, asScopedContext } from '@edge-git/backend-runtime/di';
import { createRequestScope, Tokens } from '@edge-git/backend-services/composition';
import { AccessAuthService } from '@edge-git/backend-services/auth';
import { collectEmails, presentMany, presentOne, usernameMap } from '@/workers/routes/IdentityPresenter';

function fakeScopeWithResolver(resolver: unknown): ReturnType<typeof createRequestScope> {
  return { get: () => resolver } as never;
}

describe('harden single-commit: IdentityPresenter nested redaction', () => {
  it('redacts emails in threads/reviews/discussions/replies/children, not just comments', async () => {
    const map = new Map([
      ['a@x.co', 'alice'],
      ['b@x.co', 'bob'],
    ]);
    const row = {
      title: 'pr',
      threads: [{ author_email: 'a@x.co', replies: [{ author_email: 'b@x.co' }] }],
      reviews: [{ author_email: 'b@x.co' }],
      discussions: [{ author_email: 'a@x.co' }],
      children: [{ creator_email: 'b@x.co' }],
      comments: [{ author_email: 'a@x.co' }],
    };
    const out = presentOne(row as never, map);
    const raw = JSON.stringify(out);
    expect(raw).not.toContain('a@x.co');
    expect(raw).not.toContain('b@x.co');
    expect(raw).toContain('alice');
    expect(raw).toContain('bob');
  });

  it('collects nested emails so presentMany resolves them', async () => {
    const rows = [{ threads: [{ author_email: 'a@x.co', replies: [{ author_email: 'b@x.co' }] }] }];
    const emails = collectEmails(rows as never);
    expect(emails).toContain('a@x.co');
    expect(emails).toContain('b@x.co');
    const scope = fakeScopeWithResolver({
      resolveUsernames: async (keys: string[]) => new Map(keys.map((k) => [k, k.split('@')[0] ?? 'ghost'])),
    });
    const presented = await presentMany(scope, rows as never);
    expect(JSON.stringify(presented)).not.toContain('@x.co');
  });

  it('maps granted_by to grantedBy instead of dropping attribution', () => {
    const out = presentOne({ granted_by: 'a@x.co' } as never, new Map([['a@x.co', 'alice']]));
    expect(out['grantedBy']).toBe('alice');
    expect('granted_by' in out).toBe(false);
  });

  it('maps user_email to username even without a role key', () => {
    const out = presentOne({ user_email: 'a@x.co' } as never, new Map([['a@x.co', 'alice']]));
    expect(out['username']).toBe('alice');
    expect('user_email' in out).toBe(false);
  });

  it('usernameMap fails closed (propagates outage) instead of ghosting', async () => {
    const scope = fakeScopeWithResolver({
      resolveUsernames: async () => {
        throw new Error('D1 down');
      },
    });
    await expect(usernameMap(scope, ['a@x.co'])).rejects.toThrow();
  });
});

describe('harden single-commit: single scope per request', () => {
  it('BaseRoute.getScope returns the middleware-installed scope (memoized)', () => {
    const store = new Map<string, unknown>();
    const c = {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => {
        store.set(k, v);
      },
      env: { DB: {} },
    } as never;
    const scope = createRequestScope({ DB: {} } as never);
    const ctx = createServiceContext({ DB: {} } as never);
    setRequestScope(asScopedContext(c), scope, ctx);
    expect(BaseRoute.getScope(c)).toBe(scope);
    expect(getRequestScope(asScopedContext(c))).toBe(scope);
  });

  it('Container memoizes a single PermissionService binding per scope', () => {
    const scope = new Container();
    let calls = 0;
    scope.bind(Tokens.PermissionService, () => {
      calls += 1;
      return { marker: calls } as never;
    });
    const first = scope.get(Tokens.PermissionService);
    const second = scope.get(Tokens.PermissionService);
    expect(second).toBe(first);
    expect(calls).toBe(1);
  });
});

describe('harden single-commit: auth bypass closed in production', () => {
  it('ignores DEV_AUTH_EMAIL when ENVIRONMENT=production', async () => {
    const svc = new AccessAuthService({ DEV_AUTH_EMAIL: 'dev@x.co', ENVIRONMENT: 'production' } as never);
    await expect(svc.getAuthenticatedUserEmail(new Request('https://x/'))).rejects.toThrow();
  });

  it('honors DEV_AUTH_EMAIL in development', async () => {
    const svc = new AccessAuthService({ DEV_AUTH_EMAIL: 'Dev@X.CO ', ENVIRONMENT: 'development' } as never);
    await expect(svc.getAuthenticatedUserEmail(new Request('https://x/'))).resolves.toBe('dev@x.co');
  });

  it('rejects unverified ctx identities (fail closed)', async () => {
    const svc = new AccessAuthService({ ENVIRONMENT: 'production' } as never);
    const accessCtx = { access: { getIdentity: async () => ({ email: 'a@x.co', emailVerified: false }) } };
    await expect(svc.getAuthenticatedUserEmail(new Request('https://x/'), accessCtx as never)).rejects.toThrow();
  });
});
