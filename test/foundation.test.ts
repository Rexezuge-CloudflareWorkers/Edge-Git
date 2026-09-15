import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  DatabaseError,
  ForbiddenError,
  InternalServerError,
  MethodNotAllowedError,
  NotFoundError,
  UnauthorizedError,
} from '@edge-git/backend-errors';
import { Container } from '@edge-git/backend-runtime/di/Container';
import { ConsoleLogger, SystemClock, createServiceContext } from '@edge-git/backend-runtime/di/ServiceContext';
import { cache } from '@edge-git/backend-runtime/cache';
import { AppConfiguration } from '@edge-git/backend-runtime/config/AppConfiguration';
import { ConfigurationManager } from '@edge-git/backend-runtime/config/ConfigurationManager';
import { CryptoUtil } from '@edge-git/shared/utils/CryptoUtil';
import { UUIDUtil } from '@edge-git/shared/utils/UUIDUtil';
import { TimestampUtil } from '@edge-git/shared/utils/TimestampUtil';

describe('backend-errors', () => {
  it('exposes status codes and retryability', () => {
    expect(new BadRequestError('x').getErrorCode()).toBe(400);
    expect(new UnauthorizedError('x').getErrorCode()).toBe(401);
    expect(new ForbiddenError('x').getErrorCode()).toBe(403);
    expect(new NotFoundError('x').getErrorCode()).toBe(404);
    expect(new MethodNotAllowedError('x').getErrorCode()).toBe(405);
    expect(new InternalServerError('x').getErrorCode()).toBe(500);
    expect(new DatabaseError('x', true).retryable).toBe(true);
    expect(new DatabaseError('x').retryable).toBe(false);
  });
});

describe('DI container', () => {
  it('binds, memoizes, and resolves distinctly', () => {
    const c = new Container();
    const token = 'svc' as unknown as Parameters<Container['get']>[0];
    let n = 0;
    c.bind(token, () => ({ n: (n += 1) }));
    expect(c.has(token)).toBe(true);
    expect(c.get<{ n: number }>(token)).toBe(c.get(token));
    expect(c.resolve<{ n: number }>(token)).not.toBe(c.get(token));
    expect(() => c.get('missing' as never)).toThrow('no binding');
    const child = c.createChild();
    expect(child.has(token)).toBe(true);
  });

  it('creates service contexts with defaults and overrides', () => {
    const base = createServiceContext({ DB: null });
    expect(base.logger).toBeInstanceOf(ConsoleLogger);
    expect(base.clock).toBeInstanceOf(SystemClock);
    expect(base.clock.nowSeconds()).toBeLessThanOrEqual(TimestampUtil.getCurrentUnixTimestampInSeconds());
    const logger = new ConsoleLogger();
    const ctx = createServiceContext({ DB: null }, { logger });
    expect(ctx.logger).toBe(logger);
  });
});

describe('cache key builder', () => {
  it('builds stable urls with params', () => {
    const url = cache.buildCacheKey({ key: 'repos', params: { owner: 'alice', empty: undefined } });
    expect(url.pathname).toBe('/__cache/repos');
    expect(url.searchParams.get('owner')).toBe('alice');
    expect(url.searchParams.has('empty')).toBe(false);
  });
});

describe('configuration surface', () => {
  it('covers all manager groups', () => {
    const env = {
      DEBUG_MODE: 'true',
      SITE_URL: 'https://git.example.com/',
      SERVE_SPA_FROM_WORKER: 'false',
      DEMO_MODE: 'true',
      MAX_REPOS_PER_USER: '3',
      MAX_TOKENS_PER_USER: '2',
      MAX_TOKEN_EXPIRY_DAYS: '9',
      MAX_PACK_OBJECTS: '11',
      GIT_CACHE_TTL_SECONDS: '13',
      BACKGROUND_TASK_RUN_RETENTION_DAYS: '17',
      AUDIT_LOG_RETENTION_DAYS: '19',
    };
    expect(ConfigurationManager.getDebugMode(env)).toBe(true);
    expect(ConfigurationManager.site.getSiteUrl(env)).toBe('https://git.example.com');
    expect(ConfigurationManager.spa.isServeFromWorker(env)).toBe(false);
    expect(ConfigurationManager.auth.isDemoMode(env)).toBe(true);
    expect(ConfigurationManager.repo.getMaxPackObjects(env)).toBe(11);
    expect(ConfigurationManager.repo.getCacheTtlSeconds(env)).toBe(13);
    expect(ConfigurationManager.processing.getTaskRunRetentionDays(env)).toBe(17);
    expect(ConfigurationManager.processing.getAuditLogRetentionDays(env)).toBe(19);
    const app = AppConfiguration.fromEnv(env);
    expect(app.getDebugMode()).toBe(true);
    expect(app.getMaxReposPerUser()).toBe(3);
    expect(app.getMaxTokensPerUser()).toBe(2);
    expect(app.getMaxTokenExpiryDays()).toBe(9);
    expect(app.getMaxPackObjects()).toBe(11);
    expect(app.getGitCacheTtlSeconds()).toBe(13);
    expect(app.getTaskRunRetentionDays()).toBe(17);
    expect(app.getAuditLogRetentionDays()).toBe(19);
    expect(app.isDemoMode()).toBe(true);
    expect(app.isServeSpaFromWorker()).toBe(false);
  });
});

describe('shared utils', () => {
  it('uuid and timestamps behave', () => {
    expect(UUIDUtil.getRandomUUID()).toMatch(/^[0-9a-f-]{36}$/);
    expect(UUIDUtil.getRandomUUIDNoDash()).toMatch(/^[0-9a-f]{32}$/);
    const t = TimestampUtil.getCurrentUnixTimestampInSeconds();
    expect(TimestampUtil.addDays(t, 1) - t).toBe(86_400);
    expect(TimestampUtil.convertIsoToUnixTimestampInSeconds(new Date(t * 1000).toISOString())).toBe(t);
  });

  it('crypto helpers hash and encode', async () => {
    expect(await CryptoUtil.sha256Hex('x')).toMatch(/^[0-9a-f]{64}$/);
    expect(await CryptoUtil.hmacSha256Hex('msg', 'secret')).toMatch(/^[0-9a-f]{64}$/);
    expect(CryptoUtil.toBase64Url(new Uint8Array([1, 2, 3]))).toBeTruthy();
    expect(CryptoUtil.randomBase64Url(16)).toBeTruthy();
  });
});
