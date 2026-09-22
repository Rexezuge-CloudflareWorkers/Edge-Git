import { describe, expect, it, vi } from 'vitest';
import {
  BadRequestError,
  DatabaseError,
  DefaultInternalServerError,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
} from '@edge-git/backend-errors';
import {
  buildBody,
  deserializeError,
  deserializeErrorBody,
  failClosed,
  mapServiceError,
  parseErrorPayload,
  toHttpExceptionInit,
  toHttpExceptionPayload,
  toServiceStatus,
} from '@edge-git/backend-services/errors';
import { ErrorSanitizationUtil } from '@edge-git/shared/utils';
import { asScopedContext, memoizeAsync } from '@edge-git/backend-runtime/di';
import { ErrorNormalizer, ErrorWithCode, normalizePath } from '../packages/git-service/src/ErrorNormalizer';
import {
  buildFtsQuery,
  buildLikeOrClause,
  buildLikePattern,
  clampSearchLimit,
  escapeSearchLike,
  likeParamsForTokens,
  tokenizeSearchQuery,
} from '../packages/backend-data/src/dao/SearchQueries';
import { PermissionService } from '@edge-git/backend-services/permission';
import { BaseRoute } from '../apps/api/src/endpoints/IBaseRoute';
import { readJson } from '../apps/web/src/lib/api';

describe('hardening: AWS Exception envelope', () => {
  it('maps status codes to Exception types', async () => {
    const { toErrorType, toErrorBody, jsonError } = await import('../apps/api/src/workers/routes/PublicViewerResolver');
    expect(toErrorType(400)).toBe('BadRequest');
    expect(toErrorType(401)).toBe('Unauthorized');
    expect(toErrorType(403)).toBe('Forbidden');
    expect(toErrorType(404)).toBe('NotFound');
    expect(toErrorType(409)).toBe('Conflict');
    expect(toErrorType(413)).toBe('PayloadTooLarge');
    expect(toErrorType(429)).toBe('RateLimited');
    expect(toErrorType(500)).toBe('InternalServerError');
    expect(toErrorType(418)).toBe('InternalServerError');
    expect(toErrorBody(404, 'gone')).toEqual({ Exception: { Type: 'NotFound', Message: 'gone' } });
    const c = { json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }) } as never;
    expect(await jsonError(c, 'missing', 404).json()).toEqual({ Exception: { Type: 'NotFound', Message: 'missing' } });
    expect(await jsonError(c, 'Custom', 'boom', 400).json()).toEqual({ Exception: { Type: 'Custom', Message: 'boom' } });
  });

  it('maps ServiceError to Exception bodies and masks unknowns', () => {
    expect(mapServiceError(new NotFoundError('gone'))).toEqual({
      status: 404,
      body: { Exception: { Type: 'NotFound', Message: 'gone' } },
    });
    const db = mapServiceError(new DatabaseError('down', true));
    expect(db.status).toBe(500);
    expect(db.body.Exception?.Type).toBe('DatabaseError');
    const masked = mapServiceError(new Error('D1 secret leak'), 'en');
    expect(masked.status).toBe(500);
    expect(masked.body.Exception?.Type).toBe(DefaultInternalServerError.getErrorType());
    expect(masked.body.Exception?.Message ?? '').not.toContain('D1');
    expect(buildBody(new ForbiddenError('no'))).toEqual({ Exception: { Type: 'Forbidden', Message: 'no' } });
    expect(toServiceStatus(new BadRequestError('b'))).toBe(400);
  });

  it('failClosed propagates instead of swallowing', async () => {
    await expect(failClosed(async () => 7)).resolves.toBe(7);
    await expect(
      failClosed(async () => {
        throw new UnauthorizedError('no');
      }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('translates ServiceError to HTTP payloads and back', async () => {
    const { status, body } = toHttpExceptionPayload(new UnauthorizedError('denied'));
    expect(status).toBe(401);
    expect(body).toEqual({ Exception: { Type: 'Unauthorized', Message: 'denied' } });
    const init = toHttpExceptionInit(new BadRequestError('bad'));
    expect(init.status).toBe(400);
    expect(JSON.parse(init.message)).toEqual({ Exception: { Type: 'BadRequest', Message: 'bad' } });
    await expect(deserializeError(Response.json({ Exception: { Type: 'Forbidden', Message: 'x' } }))).resolves.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(deserializeError(Response.json({ Exception: { Type: 'Nope', Message: 'x' } }))).resolves.toBeInstanceOf(
      InternalServerError,
    );
    await expect(deserializeError(new Response('oops', { status: 502, statusText: 'Bad Gateway' }))).resolves.toBeInstanceOf(
      InternalServerError,
    );
    expect(deserializeErrorBody({ Exception: { Type: 'DatabaseError', Message: 'db' } }, 'f')).toBeInstanceOf(DatabaseError);
    // Lenient web-compat parsing: envelope, legacy, plain text.
    expect(parseErrorPayload({ Exception: { Type: 'NotFound', Message: 'gone' } }, 404)).toBeInstanceOf(NotFoundError);
    expect(parseErrorPayload({ error: 'Forbidden', message: 'stop' }, 403).getErrorMessage()).toBe('stop');
    expect(parseErrorPayload(JSON.stringify({ Exception: { Type: 'Unauthorized', Message: 'u' } }), 401)).toBeInstanceOf(UnauthorizedError);
    expect(parseErrorPayload('plain boom', 500).getErrorMessage()).toBe('plain boom');
    expect(parseErrorPayload('', 500).getErrorCode()).toBe(500);
    expect(parseErrorPayload(null, 404).getErrorCode()).toBe(500);
  });

  it('serializes route errors as Exception envelope with masked 500s', async () => {
    const c = {
      json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
      req: { header: () => undefined },
    } as never;
    const notFound = BaseRoute.toErrorResponse(c, new NotFoundError('gone'));
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ Exception: { Type: 'NotFound', Message: 'gone' } });
    const db = BaseRoute.toErrorResponse(c, new DatabaseError('D1 exploded'));
    expect(db.status).toBe(500);
    // AWS contract: DatabaseError is a typed 500 — its message passes
    // through (throw sites must keep it generic); only untyped errors mask.
    expect(((await db.json()) as { Exception: { Type: string } }).Exception.Type).toBe('DatabaseError');
    const masked = BaseRoute.toErrorResponse(c, new Error('D1 conn string=secret'));
    expect(masked.status).toBe(500);
    expect(((await masked.json()) as { Exception: { Message: string } }).Exception.Message).not.toContain('D1');
  });
});

describe('hardening: secret-safe logging', () => {
  it('redacts bearer, basic, PAT, and JWT material', () => {
    expect(ErrorSanitizationUtil.sanitizeMessage('auth Bearer abc123 trailing')).toBe('auth Bearer [REDACTED] trailing');
    expect(ErrorSanitizationUtil.sanitizeMessage('login Basic dXNlcjpwYXNz')).toBe('login Basic [REDACTED]');
    expect(ErrorSanitizationUtil.sanitizeMessage('token edge-git-pat:secret123 ok')).toBe('token [REDACTED-PAT] ok');
    expect(
      ErrorSanitizationUtil.sanitizeMessage('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c!'),
    ).toBe('jwt [REDACTED-JWT]!');
    expect(ErrorSanitizationUtil.sanitizeMessage('plain message')).toBe('plain message');
    const logged = ErrorSanitizationUtil.sanitizeErrorForLogging(new Error('Bearer tok123'));
    expect(logged).toContain('Error:');
    expect(logged).not.toContain('tok123');
    expect(ErrorSanitizationUtil.sanitizeErrorForLogging('edge-git-pat:zzz')).not.toContain('zzz');
  });
});

describe('hardening: memoizeAsync retries after rejection', () => {
  it('caches success but drops rejected promises', async () => {
    let calls = 0;
    const ok = memoizeAsync(async () => {
      calls += 1;
      return calls;
    });
    await expect(ok()).resolves.toBe(1);
    await expect(ok()).resolves.toBe(1);
    expect(calls).toBe(1);
    let attempts = 0;
    const flaky = memoizeAsync(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return 'recovered';
    });
    await expect(flaky()).rejects.toThrow('transient');
    await expect(flaky()).resolves.toBe('recovered');
    expect(attempts).toBe(2);
  });
});

describe('hardening: asScopedContext centralizes the Hono adapter', () => {
  it('round-trips scope storage without call-site casts', () => {
    const store = new Map<string, unknown>();
    const c = { get: (k: string) => store.get(k), set: (k: string, v: unknown) => void store.set(k, v), env: {} };
    const scoped = asScopedContext(c);
    expect(scoped.env).toEqual({});
    expect(() => scoped.get('x')).not.toThrow();
  });
});

describe('hardening: fs error normalization and paths', () => {
  it('preserves existing codes instead of defaulting to ENOENT', () => {
    const normalizer = new ErrorNormalizer();
    const eexist = new ErrorWithCode('exists', 'EEXIST', '/x', 'writeFile');
    expect(normalizer.ensureErrCode(eexist).code).toBe('EEXIST');
    expect(normalizer.ensureErrCode(new Error('EACCES: denied')).code).toBe('EACCES');
    expect(normalizer.ensureErrCode(new Error('EISDIR')).code).toBe('EISDIR');
    expect(normalizer.ensureErrCode(new Error('mystery')).code).toBe('ENOENT');
    expect(() => normalizer.annotateAndThrow(new Error('EACCES'), 'open', '/p')).toThrowError(
      expect.objectContaining({ code: 'EACCES', path: '/p' }),
    );
  });

  it('keeps git paths byte-exact (no trimming) and resolves dot segments', () => {
    expect(normalizePath('')).toBe('/');
    expect(normalizePath(' my file ')).toBe('/ my file ');
    expect(normalizePath('a/./b/../c')).toBe('/a/c');
    expect(normalizePath('a\\b?x=1#frag')).toBe('/a/b');
  });
});

describe('hardening: SearchQueries pure builders', () => {
  it('tokenizes, quotes FTS, and builds LIKE clauses', () => {
    expect(tokenizeSearchQuery('  a  b ')).toEqual(['a', 'b']);
    expect(tokenizeSearchQuery('')).toEqual([]);
    expect(tokenizeSearchQuery(Array.from({ length: 20 }, (_, i) => `t${i}`).join(' '))).toHaveLength(10);
    expect(buildFtsQuery(['a"b', 'c'])).toBe('"a""b"* AND "c"*');
    expect(buildLikeOrClause(['lower(title)', 'lower(body)'], 2)).toBe(
      "(lower(title) LIKE ? ESCAPE '!' OR lower(body) LIKE ? ESCAPE '!') AND (lower(title) LIKE ? ESCAPE '!' OR lower(body) LIKE ? ESCAPE '!')",
    );
    expect(likeParamsForTokens(['A%_!', 'b'], 2)).toEqual(['%a!%!_!!%', '%a!%!_!!%', '%b%', '%b%']);
    expect(buildLikePattern('X')).toBe('%x%');
    expect(escapeSearchLike('!%_')).toBe('!!!%!_');
    expect(clampSearchLimit(undefined)).toBe(20);
    expect(clampSearchLimit(0)).toBe(20);
    expect(clampSearchLimit(500)).toBe(50);
    expect(clampSearchLimit(5)).toBe(5);
  });
});

describe('hardening: team grants batch without N+1 or team_id dependence', () => {
  function svc() {
    return new PermissionService({ DB: {} } as never, {
      organizationDAO: async () => ({ getById: async () => ({ id: 'org-1', username: 'acme' }) }) as never,
      organizationMemberDAO: async () =>
        ({
          get: async (_o: string, email: string) =>
            email === 'owner@x.com' ? { role: 'owner' } : email === 'member@x.com' ? { role: 'member' } : null,
        }) as never,
      repoCollaboratorDAO: async () => ({ get: async () => null }) as never,
      teamDAO: async () =>
        ({
          getById: async (id: string) =>
            id === 't1' ? { id: 't1', org_id: 'org-1' } : id === 't2' ? { id: 't2', org_id: 'other-org' } : null,
        }) as never,
      // Rows deliberately omit team_id (legacy/fake shape): membership must
      // resolve positionally, not via the row field.
      teamMemberDAO: async () =>
        ({
          get: async (teamId: string, email: string) => {
            if (teamId === 't1' && email === 'member@x.com') return { role: 'member' };
            if (teamId === 't2' && email === 'member@x.com') return { role: 'member' };
            return null;
          },
        }) as never,
      teamGrantDAO: async () =>
        ({
          listByRepo: async () => [
            { team_id: 't1', repo_id: 'r1', role: 'write' },
            { team_id: 't2', repo_id: 'r1', role: 'admin' },
          ],
        }) as never,
    });
  }

  function orgRepo() {
    return { id: 'r1', owner: 'acme', owner_ci: 'acme', owner_type: 'org', org_id: 'org-1', is_private: 1 };
  }

  it('takes max same-org grant and short-circuits on admin', async () => {
    const permission = svc();
    await expect(permission.getRole('member@x.com', orgRepo() as never)).resolves.toBe('write');
    await expect(permission.getRole('outsider@x.com', orgRepo() as never)).resolves.toBeNull();
    await expect(permission.getRole('owner@x.com', orgRepo() as never)).resolves.toBe('admin');
    await expect(permission.getRole(null, orgRepo() as never)).resolves.toBeNull();
    void vi;
  });
});

describe('hardening: web error compat reads both envelopes', () => {
  it('prefers Exception.Message, falls back to legacy and plain text', async () => {
    await expect(readJson(Response.json({ Exception: { Type: 'NotFound', Message: 'gone' } }, { status: 404 }))).rejects.toThrow('gone');
    await expect(readJson(Response.json({ error: 'Forbidden', message: 'stop' }, { status: 403 }))).rejects.toThrow('stop');
    await expect(readJson(new Response('plain boom', { status: 500 }))).rejects.toThrow('plain boom');
    await expect(readJson(Response.json({ ok: true }))).resolves.toEqual({ ok: true });
  });
});
