import { describe, expect, it } from 'vitest';
import { NonRetryableError } from '@edge-git/backend-errors/NonRetryableError';
import { RetryableError } from '@edge-git/backend-errors/RetryableError';
import {
  AiSummaryRetryableError,
  OAuth2TokenNonRetryableError,
  OAuth2TokenRetryableError,
  ProviderApiNonRetryableError,
  ProviderApiRetryableError,
} from '@edge-git/backend-errors/ProviderErrors';
import { UnauthorizedError, MethodNotAllowedError, InternalServerError } from '@edge-git/backend-errors';
import { mapServiceError, hideExistence } from '@edge-git/backend-services/errors';
import {
  ConsoleLogger,
  FixedClock,
  NullLogger,
  SystemClock,
  createServiceContext,
} from '@edge-git/backend-runtime/di/ServiceContext';
import { SearchService } from '@edge-git/backend-services/search';
import { coversScope } from '@edge-git/backend-services/auth/TokenScopes';
import { buildQuery, unwrapList, apiAuthedFirst } from '../apps/web/src/lib/api';
import { canWrite, canWriteRepo } from '../apps/web/src/lib/permissions';
import { normalizeLocale, resolveLocale } from '../apps/web/src/lib/locale';

describe('backend-errors constructors', () => {
  it('exposes codes, types, messages', () => {
    expect(new NonRetryableError('boom').getErrorCode()).toBe(500);
    expect(new NonRetryableError('boom').getErrorType()).toBe('NonRetryableError');
    expect(new RetryableError('retry').getErrorCode()).toBe(500);
    expect(new UnauthorizedError('no').getErrorCode()).toBe(401);
    expect(new MethodNotAllowedError('no').getErrorCode()).toBe(405);
    expect(new InternalServerError('x').getErrorCode()).toBe(500);
    expect(new AiSummaryRetryableError('ai', { aiUsage: { t: 1 } }).aiUsage).toMatchObject({ t: 1 });
    expect(new ProviderApiRetryableError('p').getErrorCode()).toBe(500);
    expect(new ProviderApiNonRetryableError('p').getErrorCode()).toBe(500);
    expect(new OAuth2TokenRetryableError('o').getErrorCode()).toBe(500);
    expect(new OAuth2TokenNonRetryableError('o').getErrorCode()).toBe(500);
  });

  it('maps unknown errors to generic 500', () => {
    expect(mapServiceError(new Error('D1 secret')).status).toBe(500);
    expect(mapServiceError(new Error('D1 secret')).body.Exception?.Message ?? '').not.toContain('D1');
    expect(mapServiceError(new UnauthorizedError('denied')).status).toBe(401);
  });

  it('hideExistence swallows to null', async () => {
    await expect(hideExistence(async () => 'ok')).resolves.toBe('ok');
    await expect(
      hideExistence(async () => {
        throw new Error('gone');
      }),
    ).resolves.toBeNull();
  });
});

describe('service context doubles', () => {
  it('creates contexts with defaults and overrides', () => {
    const base = createServiceContext({} as never);
    expect(base.logger).toBeInstanceOf(ConsoleLogger);
    expect(base.clock).toBeInstanceOf(SystemClock);
    const fixed = createServiceContext({} as never, { logger: new NullLogger(), clock: new FixedClock(42) });
    expect(fixed.clock.nowSeconds()).toBe(42);
    const log = new NullLogger();
    expect(() => log.debug('x')).not.toThrow();
    expect(() => log.info('x')).not.toThrow();
    expect(() => log.warn('x')).not.toThrow();
    expect(() => log.error('x')).not.toThrow();
    // ConsoleLogger forwards without throwing
    const consoleLog = new ConsoleLogger();
    expect(() => consoleLog.debug('x')).not.toThrow();
  });
});

describe('search guards', () => {
  it('sanitizes and clamps', () => {
    expect(() => SearchService.parseType('evil')).not.toThrow();
    expect(SearchService.clampLimit('999')).toBeLessThanOrEqual(50);
    expect(SearchService.clampLimit('5')).toBe(5);
  });

  it('covers scope hierarchy', () => {
    expect(coversScope(['admin'], 'repo:read')).toBe(true);
    expect(coversScope(['repo:read'], 'repo:write')).toBe(false);
    expect(coversScope(['repo:write'], 'repo:read')).toBe(true);
  });
});

describe('web helpers parity', () => {
  it('builds queries and unwraps lists', () => {
    expect(buildQuery({ q: 'hi', empty: '', skip: undefined })).toContain('q=hi');
    expect(buildQuery({ tag: ['a', 'b'] })).toContain('tag=a');
    expect(unwrapList({ items: [1, 2] }, 'items')).toEqual([1, 2]);
    expect(unwrapList({}, 'missing')).toEqual([]);
  });

  it('checks write roles', () => {
    expect(canWrite('admin')).toBe(true);
    expect(canWrite('write')).toBe(true);
    expect(canWrite('read')).toBe(false);
    expect(canWrite(null)).toBe(false);
    expect(canWriteRepo({ viewerRole: 'write', viewerCanManage: false })).toBe(true);
    expect(canWriteRepo({ viewerRole: 'read', viewerCanManage: false })).toBe(false);
    expect(canWriteRepo(null)).toBe(false);
  });

  it('normalizes locales with fallback', () => {
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('zh')).toBe('zh-CN');
    expect(normalizeLocale('xx-YY')).toBe('en');
    expect(normalizeLocale(null)).toBe('en');
    expect(resolveLocale('en')).toBe('en');
    expect(resolveLocale(null)).toBe('en');
  });

  it('prefers authed path with public fallback', async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: string | URL | Request) => {
      calls += 1;
      const href = String(url);
      if (href.includes('/user/')) return new Response('boom', { status: 500 });
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      await expect(apiAuthedFirst('/user/repos/a/b', '/repos/a/b', false)).resolves.toMatchObject({ ok: true });
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
