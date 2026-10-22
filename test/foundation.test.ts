import { describe, expect, it } from 'vitest';
import {
  BadRequestError,
  DatabaseError,
  ForbiddenError,
  InternalServerError,
  MethodNotAllowedError,
  NotFoundError,
  UnauthorizedError,
} from '@rexezuge/errors';
import { Container } from '@edge-git/backend-runtime/di/Container';
import { ConsoleLogger, SystemClock, createServiceContext } from '@edge-git/backend-runtime/di/ServiceContext';
import { buildKvKey, createKvCache } from '@edge-git/backend-runtime/kv';
import { AppConfiguration } from '@edge-git/backend-runtime/config/AppConfiguration';
import { ConfigurationManager } from '@edge-git/backend-runtime/config/ConfigurationManager';
import { CryptoUtil, TimestampUtil, UUIDUtil } from '@rexezuge/shared';

describe('backend-errors', () => {
  it('exposes status codes and retryability', () => {
    expect(new BadRequestError('x').status).toBe(400);
    expect(new UnauthorizedError('x').status).toBe(401);
    expect(new ForbiddenError('x').status).toBe(403);
    expect(new NotFoundError('x').status).toBe(404);
    expect(new MethodNotAllowedError('x').status).toBe(405);
    expect(new InternalServerError('x').status).toBe(500);
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
    expect(c.get<{ n: number }>(token).n).toBe(1);
    expect(() => c.get('missing' as never)).toThrow();
    // The kit's container is deliberately minimal: factory + singleton scopes
    // and branded tokens, nothing else. A container that grows features grows
    // coupling with it, so `resolve`/`createChild`/`dispose` are gone.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(c)).sort()).toEqual([
      'bind',
      'bindValue',
      'constructor',
      'get',
      'has',
    ]);
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

describe('single-KV keyspace', () => {
  it('builds stable domain-prefixed keys', () => {
    const cache = createKvCache(null);
    expect(buildKvKey('refs', ['alice/demo', 'abc'])).toBe('refs:v1:alice%2Fdemo:abc');
    expect(buildKvKey('jwks', ['alice/demo', 'abc'])).not.toBe(buildKvKey('refs', ['alice/demo', 'abc']));
    expect(cache.available).toBe(false);
  });
});

describe('configuration surface', () => {
  it('covers all manager groups', () => {
    const env = {
      DEBUG_MODE: 'true',
      SITE_URL: 'https://git.example.com/',
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
