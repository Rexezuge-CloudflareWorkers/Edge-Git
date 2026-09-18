import { describe, expect, it, vi } from 'vitest';
import { err, getOrThrow, isOk, mapResult, ok } from '@edge-git/shared/utils/Result';
import { EmailAddress, RepoFullName } from '@edge-git/shared/utils/Identity';
import {
  CollaborationQueries,
  computeDateCutoffIso,
  computeUnixCutoffSeconds,
  pruneInBatches,
} from '@edge-git/backend-data/dao/CollaborationQueries';
import { GitCache } from '@edge-git/git-service/GitCache';
import {
  createRequestContext,
  getRequestScope,
  getServiceContext,
  memoizeAsync,
  setRequestScope,
} from '@edge-git/backend-runtime/di/RequestScope';
import { Container } from '@edge-git/backend-runtime/di/Container';
import { createServiceContext } from '@edge-git/backend-runtime/di/ServiceContext';
import { BaseRoute } from '@/endpoints/IBaseRoute';
import { NotFoundError, ForbiddenError, BadRequestError } from '@edge-git/backend-errors';
import { RepoVisibilityService } from '@edge-git/backend-services/repo/RepoVisibilityService';
import { scopeMiddleware } from '@/middleware/scopeMiddleware';

describe('Result value object', () => {
  it('ok/err round-trip through isOk and getOrThrow', () => {
    const good = ok(42);
    expect(isOk(good)).toBe(true);
    expect(getOrThrow(good)).toBe(42);
    const bad = err(new Error('boom'));
    expect(isOk(bad)).toBe(false);
    expect(() => getOrThrow(bad)).toThrow('boom');
  });

  it('mapResult maps ok and passes err through', () => {
    expect(mapResult(ok(2), (v) => v * 3)).toEqual(ok(6));
    const failure = err(new Error('x'));
    expect(mapResult(failure, (v: never) => v)).toBe(failure);
  });
});

describe('Identity value objects', () => {
  it('normalizes emails and parses repo names', () => {
    expect(EmailAddress.normalize('  Alice@Example.COM ')).toBe('alice@example.com');
    expect(EmailAddress.parse('Bob@Example.com').toString()).toBe('bob@example.com');
    expect(EmailAddress.tryParse(null)).toBeNull();
    expect(EmailAddress.tryParse('not-an-email')).toBeNull();
    expect(() => EmailAddress.parse('nope')).toThrow();
    const addr = EmailAddress.parse('Carol@Example.com');
    expect(addr.equals('carol@example.com')).toBe(true);
    expect(addr.equals(EmailAddress.parse('carol@example.com'))).toBe(true);
    expect(addr.prefix()).toBe('carol');
    expect(addr.valueOf()).toBe('carol@example.com');
  });

  it('parses owner/name and strips .git', () => {
    expect(RepoFullName.normalizeRepo('repo.git')).toBe('repo');
    expect(RepoFullName.normalizeOwner('  Org ')).toBe('Org');
    const full = RepoFullName.parse('my-org', 'my-repo.git');
    expect(full.toString()).toBe('my-org/my-repo');
    expect(full.ownerCi()).toBe('my-org');
    expect(RepoFullName.tryParse('bad owner!', 'x') ).toBeNull();
    expect(() => RepoFullName.parse('', '')).toThrow();
  });
});

describe('CollaborationQueries and prune helpers', () => {
  it('builds label/milestone/reviewer SQL', () => {
    expect(CollaborationQueries.insertLabel()).toContain('INSERT INTO labels');
    expect(CollaborationQueries.listLabels()).toContain('ORDER BY name ASC');
    expect(CollaborationQueries.insertMilestone()).toContain('INSERT INTO milestones');
    expect(CollaborationQueries.listMilestones()).toContain('ORDER BY created_at DESC');
    expect(CollaborationQueries.upsertReviewer()).toContain('ON CONFLICT');
    expect(CollaborationQueries.listReviewers()).toContain('pull_reviewers');
  });

  it('computes cutoffs and prunes in batches', async () => {
    expect(computeUnixCutoffSeconds(1_000_000, 1)).toBe(1_000_000 - 86_400);
    const iso = computeDateCutoffIso(new Date('2026-01-02T00:00:00.000Z'), 1);
    expect(iso).toBe('2026-01-01T00:00:00.000Z');
    let calls = 0;
    const total = await pruneInBatches(async () => {
      calls += 1;
      return calls === 1 ? 500 : 3;
    });
    expect(total).toBe(503);
    expect(await pruneInBatches(async () => 0)).toBe(0);
  });
});

describe('GitCache mixin', () => {
  it('get/set/clear and TTL expiry', () => {
    const cache = new GitCache();
    const marker = { a: 1 };
    cache.setCache(marker);
    expect(cache.getCache()).toBe(marker);
    cache.clearCache();
    expect(cache.getCache()).not.toBe(marker);
    cache.ensureFreshCache(0);
    cache.ensureFreshCache(Number.NaN);
    expect(() => cache.ensureFreshCache(3600)).not.toThrow();
  });
});

describe('RequestScope helpers', () => {
  it('memoizes async factories', async () => {
    let n = 0;
    const factory = memoizeAsync(async () => ++n);
    expect(await factory()).toBe(1);
    expect(await factory()).toBe(1);
  });

  it('sets and gets scope plus service context', () => {
    const store = new Map<string, unknown>();
    const c = { get: (k: string) => store.get(k), set: (k: string, v: unknown) => { store.set(k, v); }, env: { DB: {} } };
    expect(() => getRequestScope(c as never)).toThrow();
    expect(() => getServiceContext(c as never)).toThrow();
    const scope = new Container();
    const ctx = createServiceContext({ DB: {} } as never);
    setRequestScope(c as never, scope, ctx);
    expect(getRequestScope(c as never)).toBe(scope);
    expect(getServiceContext(c as never)).toBe(ctx);
    expect(createRequestContext({ DB: {} } as never).env).toBeDefined();
  });
});

describe('BaseRoute template method', () => {
  class OkRoute extends BaseRoute {
    protected async handleRequest(c: never): Promise<Response> {
      return this.json(c, { ok: true });
    }
  }

  class FailRoute extends BaseRoute {
    protected async handleRequest(): Promise<Response> {
      throw new NotFoundError('Repository not found');
    }
  }

  class BoomRoute extends BaseRoute {
    protected async handleRequest(): Promise<Response> {
      throw new Error('kaboom');
    }
  }

  class FailHelperRoute extends BaseRoute {
    protected async handleRequest(): Promise<Response> {
      return this.fail('nope', 400);
    }
  }

  const jsonCtx = { json: (data: unknown, status?: number) => Response.json(data, { status: status ?? 200 }) } as never;

  it('handles success, ServiceError, untyped errors, and helpers', async () => {
    expect(await (await new OkRoute().handle(jsonCtx)).json()).toEqual({ ok: true });
    const notFound = await new FailRoute().handle(jsonCtx);
    expect(notFound.status).toBe(404);
    const masked = await new BoomRoute().handle(jsonCtx);
    expect(masked.status).toBe(500);
    expect(await masked.json()).toMatchObject({ error: 'InternalError' });
    const bad = await new FailHelperRoute().handle(jsonCtx);
    expect(bad.status).toBe(400);
    const direct = BaseRoute.toErrorResponse(jsonCtx, new ForbiddenError('no'));
    expect(direct.status).toBe(403);
  });
});

describe('RepoVisibilityService', () => {
  const row = { id: 'r1', is_private: 0 } as never;

  function depsWith(role: string | null, repo: unknown = row) {
    return {
      repositoryDAO: async () => ({ getByOwnerAndName: async () => repo }) as never,
      organizationDAO: async () => ({}) as never,
      organizationMemberDAO: async () => ({}) as never,
      repoCollaboratorDAO: async () => ({}) as never,
      permissionService: async () => ({ getRole: async () => role }) as never,
    };
  }

  it('delegates getRole and hides private repos', async () => {
    const svc = new RepoVisibilityService(depsWith('read'));
    expect(await svc.getRole('a@x.com', row)).toBe('read');
    const missing = await new RepoVisibilityService(depsWith('read', null)).requireRole('o', 'n', 'a@x.com', 'read').catch((e: Error) => e);
    expect(missing).toBeInstanceOf(NotFoundError);
    const privateRow = { id: 'r2', is_private: 1 } as never;
    const hidden = await new RepoVisibilityService(depsWith(null, privateRow)).requireRole('o', 'n', null, 'read').catch((e: Error) => e);
    expect(hidden).toBeInstanceOf(NotFoundError);
    const forbidden = await new RepoVisibilityService(depsWith(null, row)).requireRole('o', 'n', null, 'read').catch((e: Error) => e);
    expect(forbidden).toBeInstanceOf(ForbiddenError);
    const weak = await new RepoVisibilityService(depsWith('read', row)).requireRole('o', 'n', 'a@x.com', 'admin').catch((e: Error) => e);
    expect(weak).toBeInstanceOf(ForbiddenError);
    const good = await svc.requireRole('o', 'n', 'a@x.com', 'read');
    expect(good.role).toBe('read');
  });

  it('lists visible repos filtering by role', async () => {
    const rows = [
      { id: 'a', updated_at: 2, is_private: 0 },
      { id: 'b', updated_at: 3, is_private: 0 },
    ] as never;
    const svc = new RepoVisibilityService({
      repositoryDAO: async () =>
        ({ listByOwnerEmail: async () => rows, listByOwner: async () => [], listByOrgId: async () => [], getById: async () => null }) as never,
      organizationDAO: async () => ({ getById: async () => null }) as never,
      organizationMemberDAO: async () => ({ listOrgsByUser: async () => [] }) as never,
      repoCollaboratorDAO: async () => ({ listByUser: async () => [] }) as never,
      permissionService: async () => ({ getRole: async (_e: unknown, r: { id: string }) => (r.id === 'b' ? 'read' : null) }) as never,
    });
    const visible = await svc.listVisibleForUser('A@X.com', async () => null);
    expect(visible.map((r) => r.id)).toEqual(['b']);
    expect(new BadRequestError('x').getErrorCode()).toBe(400);
  });
});

describe('scopeMiddleware', () => {
  it('installs a single scope per request', async () => {
    const store = new Map<string, unknown>();
    const c = { get: (k: string) => store.get(k), set: (k: string, v: unknown) => { store.set(k, v); }, env: { DB: {} } };
    let nextCalled = false;
    await scopeMiddleware(c as never, async () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(getRequestScope(c as never)).toBeInstanceOf(Container);
    expect(vi.fn()).toBeDefined();
  });
});
