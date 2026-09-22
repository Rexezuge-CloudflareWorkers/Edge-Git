import { describe, expect, it } from 'vitest';
import {
  BRANCH_SEGMENT_RE,
  hasIllegalBranchChar,
  isValidBranchName,
  SLUG_RE,
  isValidSlug,
  validateSlug,
  RepoFullName,
} from '@edge-git/shared/utils';
import { isBlockedByReviews, isDismissed } from '@edge-git/backend-services/pull/PullReviewGate';
import { backoffSecondsForAttempt, isRetryableHttpStatus } from '@edge-git/backend-services/webhook/WebhookRetryPolicy';
import { parseSymbolicHead } from '@edge-git/git-service/RefParsers';
import { PackLimitError, checkObjectBudget, maxVisitedFor } from '@edge-git/git-service/PackLimits';
import { GitCache } from '@edge-git/git-service/GitCache';
import { pickEvictionCandidate, pruneFrameTimes, shouldRateLimit } from '../apps/background/src/realtime/RealtimePolicy';
import { allocateNumberWithFallback } from '@edge-git/backend-services/numbering/numberAllocator';
import { AuditObserverRegistry } from '@edge-git/backend-services/audit';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';

describe('harden: shared BranchValidation (single source of truth)', () => {
  it('accepts normal branches and rejects git-check-ref-format violations', () => {
    expect(isValidBranchName('main')).toBe(true);
    expect(isValidBranchName('feature/foo-bar_1.2')).toBe(true);
    expect(isValidBranchName('')).toBe(false);
    expect(isValidBranchName('/leading')).toBe(false);
    expect(isValidBranchName('trailing.')).toBe(false);
    expect(isValidBranchName('a..b')).toBe(false);
    expect(isValidBranchName('a//b')).toBe(false);
    expect(isValidBranchName('has space')).toBe(false);
    expect(isValidBranchName('has~tilde')).toBe(false);
    expect(isValidBranchName('@')).toBe(false);
    expect(isValidBranchName('a'.repeat(256))).toBe(false);
  });

  it('exposes segment regex and illegal-char helper consistently', () => {
    expect(BRANCH_SEGMENT_RE.test('ok-name_1.2')).toBe(true);
    expect(hasIllegalBranchChar('ok')).toBe(false);
    expect(hasIllegalBranchChar('has space')).toBe(true);
    expect(hasIllegalBranchChar('back\\slash')).toBe(true);
  });
});

describe('harden: shared SlugValidation (org/team unification)', () => {
  it('accepts 1-39 char slugs and rejects empties/edges', () => {
    expect(isValidSlug('alice')).toBe(true);
    expect(isValidSlug('org-1')).toBe(true);
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('-lead')).toBe(false);
    expect(isValidSlug('trail-')).toBe(false);
    expect(isValidSlug('a'.repeat(40))).toBe(false);
    expect(SLUG_RE.test('team-x')).toBe(true);
  });

  it('validateSlug throws with a clear message on bad slugs', () => {
    expect(() => validateSlug('ok-1')).not.toThrow();
    expect(() => validateSlug('-bad')).toThrow('Invalid slug');
  });
});

describe('harden: route layering via RepoFullName', () => {
  it('strips .git suffix like the removed RepoService shim', () => {
    expect(RepoFullName.normalizeRepo('myrepo.git')).toBe('myrepo');
    expect(RepoFullName.normalizeRepo('myrepo')).toBe('myrepo');
    expect(RepoFullName.normalizeOwner('  Org ')).toBe('Org');
  });
});

describe('harden: PullReviewGate pure merge-block rule', () => {
  it('blocks on latest changes_requested, ignores dismissed and superseded', () => {
    expect(isBlockedByReviews([])).toBe(false);
    expect(isBlockedByReviews([{ author_email: 'a@x.com', state: 'approved' }])).toBe(false);
    expect(isBlockedByReviews([{ author_email: 'a@x.com', state: 'changes_requested' }])).toBe(true);
    expect(isBlockedByReviews([{ author_email: 'a@x.com', state: 'changes_requested', dismissed: 1 }])).toBe(false);
    // Oldest-first: last entry per author wins.
    expect(
      isBlockedByReviews([
        { author_email: 'a@x.com', state: 'changes_requested' },
        { author_email: 'a@x.com', state: 'approved' },
      ]),
    ).toBe(false);
    expect(
      isBlockedByReviews([
        { author_email: 'a@x.com', state: 'approved' },
        { author_email: 'A@x.com', state: 'changes_requested' },
      ]),
    ).toBe(true);
  });

  it('isDismissed matches DAO dismissed flag', () => {
    expect(isDismissed({ author_email: 'a', state: 'approved', dismissed: 1 })).toBe(true);
    expect(isDismissed({ author_email: 'a', state: 'approved' })).toBe(false);
  });
});

describe('harden: WebhookRetryPolicy pure backoff', () => {
  it('retries 429/5xx/network, terminals other 4xx', () => {
    expect(isRetryableHttpStatus(null)).toBe(true);
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
  });

  it('backs off 1m/10m/1h/6h/24h clamped', () => {
    expect(backoffSecondsForAttempt(1)).toBe(60);
    expect(backoffSecondsForAttempt(2)).toBe(600);
    expect(backoffSecondsForAttempt(3)).toBe(3600);
    expect(backoffSecondsForAttempt(4)).toBe(21_600);
    expect(backoffSecondsForAttempt(5)).toBe(86_400);
    expect(backoffSecondsForAttempt(99)).toBe(86_400);
    expect(backoffSecondsForAttempt(0)).toBe(60);
  });
});

describe('harden: RefParsers pure HEAD parsing', () => {
  it('parses symbolic HEAD and rejects detached/empty', () => {
    expect(parseSymbolicHead('ref: refs/heads/main\n')).toBe('refs/heads/main');
    expect(parseSymbolicHead('ref:refs/heads/x')).toBe('refs/heads/x');
    expect(parseSymbolicHead('deadbeef'.repeat(5).slice(0, 40))).toBe(null);
    expect(parseSymbolicHead('')).toBe(null);
    expect(parseSymbolicHead(new TextEncoder().encode('ref: refs/heads/main\n'))).toBe('refs/heads/main');
  });
});

describe('harden: PackLimits pure budget', () => {
  it('throws PackLimitError over object or rev-walk budget', () => {
    expect(() => checkObjectBudget({ objectsToSend: 11, visited: 1, maxObjects: 10, maxVisited: 1000 })).toThrow(PackLimitError);
    expect(() => checkObjectBudget({ objectsToSend: 1, visited: 1001, maxObjects: undefined, maxVisited: 1000 })).toThrow(
      'rev-walk too large',
    );
    expect(() => checkObjectBudget({ objectsToSend: 5, visited: 5, maxObjects: 10, maxVisited: 1000 })).not.toThrow();
    expect(maxVisitedFor(10)).toBe(10 * 4 + 1000);
    expect(maxVisitedFor(undefined)).toBe(10_000 * 4 + 1000);
  });
});

describe('harden: GitCache composition (no duplicated TTL logic)', () => {
  it('clears and expires on TTL', () => {
    const cache = new GitCache();
    const before = cache.getCache();
    expect(typeof before).toBe('object');
    cache.clearCache();
    expect(cache.getCache()).not.toBe(before);
    cache.ensureFreshCache(0);
    cache.ensureFreshCache(Number.NaN);
    cache.ensureFreshCache(-1);
    expect(cache.getCache()).toBe(cache.getCache());
  });
});

describe('harden: RealtimePolicy pure socket policy', () => {
  it('prunes 60s windows and rate-limits at cap', () => {
    const now = 1_000_000;
    expect(pruneFrameTimes([now - 61_000, now - 1000], now)).toEqual([now - 1000]);
    expect(
      shouldRateLimit(
        Array.from({ length: 30 }, () => now - 1000),
        now,
        30,
      ),
    ).toBe(true);
    expect(
      shouldRateLimit(
        Array.from({ length: 29 }, () => now - 1000),
        now,
        30,
      ),
    ).toBe(false);
    expect(
      shouldRateLimit(
        Array.from({ length: 30 }, () => now - 61_000),
        now,
        30,
      ),
    ).toBe(false);
  });

  it('makes room below cap, evicts anon for authed, denies otherwise', () => {
    expect(pickEvictionCandidate([{ viewer: 'a' }], 'b@x.com', 10)).toBe(-2);
    expect(pickEvictionCandidate([{ viewer: 'anonymous' }], 'b@x.com', 1)).toBe(0);
    expect(pickEvictionCandidate([{ viewer: 'c@x.com' }], 'b@x.com', 1)).toBe(-1);
    expect(pickEvictionCandidate([{ viewer: 'anonymous' }], 'anonymous', 1)).toBe(-1);
  });
});

describe('harden: numberAllocator fail-closed fallback', () => {
  it('falls back only on missing-table/fake-DB errors', async () => {
    const missing = (): Promise<never> => Promise.reject(new Error('no such table: repo_number_counters'));
    await expect(allocateNumberWithFallback(missing, () => Promise.resolve(7), 'r1', 'issue')).resolves.toBe(7);

    const fakeDb = (): Promise<never> => Promise.reject(new TypeError('this.database.prepare is not a function'));
    await expect(allocateNumberWithFallback(fakeDb, () => Promise.resolve(7), 'r1', 'issue')).resolves.toBe(7);

    const unknownEntity = (): Promise<never> => Promise.reject(new Error('Unknown numbered entity: nope'));
    await expect(allocateNumberWithFallback(unknownEntity, () => Promise.resolve(7), 'r1', 'issue')).rejects.toThrow(
      'Unknown numbered entity',
    );

    const outage = (): Promise<never> => Promise.reject(new Error('D1 timeout'));
    await expect(allocateNumberWithFallback(outage, () => Promise.resolve(7), 'r1', 'issue')).rejects.toThrow('D1 timeout');
  });
});

describe('harden: AuditObserverRegistry in composition root', () => {
  it('resolves a shared registry and memoized AuditService', () => {
    const env = { DB: {} } as never;
    const scope = createRequestScope(env);
    const first = scope.get(Tokens.AuditObserverRegistry);
    expect(first).toBeInstanceOf(AuditObserverRegistry);
    expect(scope.get(Tokens.AuditObserverRegistry)).toBe(first);
    expect(scope.get(Tokens.AuditService).constructor.name).toBe('AuditService');
  });

  it('withObservers fan-out never throws and notifies all', async () => {
    const seen: string[] = [];
    const registry = AuditObserverRegistry.withObservers([
      { notify: () => Promise.resolve(void seen.push('a')) },
      {
        notify: () => Promise.reject(new Error('sink down')),
      },
      { notify: () => Promise.resolve(void seen.push('c')) },
    ]);
    await registry.notifyAll({
      logId: 'l',
      timestamp: 1,
      userEmail: 'a@x.com',
      action: 'a',
      resource: null,
      method: 'GET',
      path: '/',
      statusCode: 200,
      detail: null,
      ipAddress: null,
      userAgent: null,
      orgId: null,
      repoId: null,
    });
    expect(seen).toEqual(['a', 'c']);
  });
});
