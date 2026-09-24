import { describe, expect, it } from 'vitest';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
import { EnvParser } from '@edge-git/backend-runtime/config';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { DatabaseError } from '@edge-git/backend-errors';
import { allocateNumberWithFallback } from '@edge-git/backend-services/numbering';
import { maxTeamGrantRole } from '@edge-git/backend-services/permission';
// Deep import (why: the `@edge-git/git-service` barrel pulls the `dofs`
// runtime at module load, which breaks node vitest ESM in combination with
// API route imports; `GitLogger` is dependency-free).
import { consoleGitLogger, mergeGitLogger, nullGitLogger } from '@edge-git/git-service/GitLogger';
import { rateLimit, resetRateLimitForTests } from '@/middleware/rateLimit';
import { PushBodyInvalidError, PushProtectionsUnavailableError } from '@/workers/routes/PushProtections';
import { getRepoSocial } from '@/workers/routes/RepoSocialHelper';

describe('harden all phases', () => {
  it('EnvParser strict rejects malformed explicit values but allows unset', () => {
    expect(EnvParser.strictPositiveInt({}, 'MAX_PACK_OBJECTS', '10000')).toBe(10_000);
    expect(() => EnvParser.strictPositiveInt({ MAX_PACK_OBJECTS: 'banana' }, 'MAX_PACK_OBJECTS', '10000')).toThrow(
      /MAX_PACK_OBJECTS/,
    );
    expect(() => EnvParser.strictPositiveInt({ MAX_PACK_OBJECTS: '0' }, 'MAX_PACK_OBJECTS', '10000')).toThrow();
    expect(EnvParser.isValidPositiveInt({ MAX_PACK_OBJECTS: 'banana' }, 'MAX_PACK_OBJECTS')).toBe(false);
    expect(EnvParser.isValidPositiveInt({}, 'MAX_PACK_OBJECTS')).toBe(true);
  });

  it('AppConfiguration.validate reports malformed numeric env', () => {
    expect(new AppConfiguration({}).validate()).toEqual([]);
    const warnings = new AppConfiguration({ MAX_PACK_OBJECTS: 'banana', DO_DEVICE_BYTES: '-5' }).validate();
    expect(warnings.join('\n')).toMatch(/MAX_PACK_OBJECTS/);
    expect(warnings.join('\n')).toMatch(/DO_DEVICE_BYTES/);
  });

  it('createLogger prefers injected env over process.env', () => {
    const quiet = createLogger('ns', 'repo', { LOG_LEVEL: 'error' });
    expect(typeof quiet.debug).toBe('function');
    const verbose = createLogger('ns', undefined, { LOG_LEVEL: 'debug' });
    expect(typeof verbose.debug).toBe('function');
  });

  it('DatabaseError preserves cause chain', () => {
    const root = new Error('d1 down');
    const wrapped = new DatabaseError('Failed to list team grants: d1 down', false, { cause: root });
    expect(wrapped).toBeInstanceOf(DatabaseError);
    expect((wrapped as { cause?: unknown }).cause).toBe(root);
    expect(wrapped.message).toMatch(/Failed to list team grants/);
  });

  it('allocateNumber falls back only on missing schema, rethrows outages', async () => {
    const legacy = () => Promise.resolve(41);
    // Missing table → fallback.
    await expect(
      allocateNumberWithFallback(
        () => Promise.reject(new Error('no such table: repo_number_counters')),
        legacy,
        'repo-1',
        'issue',
      ),
    ).resolves.toBe(41);
    // Missing column (deploy skew) → fallback via shared classifier.
    await expect(
      allocateNumberWithFallback(() => Promise.reject(new Error('no such column: counters.n')), legacy, 'repo-1', 'issue'),
    ).resolves.toBe(41);
    // Genuine outage mentioning counters in text must NOT fall back.
    await expect(
      allocateNumberWithFallback(() => Promise.reject(new Error('D1 timeout reading counters')), legacy, 'repo-1', 'issue'),
    ).rejects.toThrow(/D1 timeout/);
    // Fake DB without prepare → fallback.
    await expect(
      allocateNumberWithFallback(() => Promise.reject(new TypeError('dao.allocateNumber is not a function')), legacy, 'r', 'issue'),
    ).rejects.toThrow();
    await expect(
      allocateNumberWithFallback(
        () =>
          Promise.resolve({
            allocateNumber: () => {
              throw new TypeError('this.database.prepare is not a function');
            },
          }) as never,
        legacy,
        'r',
        'issue',
      ),
    ).resolves.toBe(41);
  });

  it('maxTeamGrantRole picks max applicable grant', () => {
    const grants = [
      { team_id: 't1', role: 'read' as const },
      { team_id: 't2', role: 'write' as const },
      { team_id: 't3', role: 'admin' as const },
    ];
    expect(maxTeamGrantRole(grants, () => true, () => true)).toBe('admin');
    expect(
      maxTeamGrantRole(grants, (id) => id === 't1', () => true),
    ).toBe('read');
    expect(maxTeamGrantRole(grants, () => true, (id) => id === 't1')).toBe('read');
    expect(maxTeamGrantRole([], () => true, () => true)).toBeNull();
  });

  it('git loggers default to console sink, null logger silences', () => {
    expect(typeof consoleGitLogger.warn).toBe('function');
    expect(typeof mergeGitLogger.error).toBe('function');
    expect(() => nullGitLogger.error('x')).not.toThrow();
    expect(() => nullGitLogger.warn('x')).not.toThrow();
  });

  it('rateLimit fails fast on misconfiguration', () => {
    expect(() => rateLimit({ windowMs: 0, max: 10, keyPrefix: 'x' })).toThrow(/windowMs/);
    expect(() => rateLimit({ windowMs: 1000, max: -1, keyPrefix: 'x' })).toThrow(/max/);
    expect(() => rateLimit({ windowMs: 1000, max: 10, keyPrefix: '  ' })).toThrow(/keyPrefix/);
    resetRateLimitForTests();
  });

  it('push protection errors carry stable names', () => {
    expect(new PushBodyInvalidError().name).toBe('PushBodyInvalidError');
    expect(new PushProtectionsUnavailableError().name).toBe('PushProtectionsUnavailableError');
  });

  it('getRepoSocial degrades to zeros/false on DAO outage', async () => {
    const scope = {
      get: () => ({
        countByRepo: () => Promise.reject(new Error('d1 down')),
        isStarred: () => Promise.reject(new Error('d1 down')),
        isWatching: () => Promise.reject(new Error('d1 down')),
      }),
    } as never;
    await expect(getRepoSocial(scope, 'repo-1', 'a@example.com')).resolves.toEqual({
      starsCount: 0,
      watchersCount: 0,
      viewerStarred: false,
      viewerWatching: false,
    });
    await expect(getRepoSocial(scope, 'repo-1', null)).resolves.toEqual({
      starsCount: 0,
      watchersCount: 0,
      viewerStarred: false,
      viewerWatching: false,
    });
  });
});
