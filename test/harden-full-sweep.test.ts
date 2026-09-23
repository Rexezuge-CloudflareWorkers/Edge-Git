import { describe, expect, it, vi } from 'vitest';
import { mapWithConcurrency } from '../packages/shared/src/utils/ConcurrencyUtil';
import { SLUG_RE } from '../packages/shared/src/utils/SlugValidation';
import { WikiService } from '../packages/backend-services/src/wiki/WikiService';
import { TokenService } from '../packages/backend-services/src/auth/TokenService';
import { WebhookService } from '../packages/backend-services/src/webhook/WebhookService';
import { SearchService } from '../packages/backend-services/src/search/SearchService';
import { PullRequestService } from '../packages/backend-services/src/pull/PullRequestService';
import { BranchProtectionService } from '../packages/backend-services/src/protection/BranchProtectionService';
import { isBlockedByReviews } from '../packages/backend-services/src/pull/PullReviewGate';
import { countApprovals } from '../packages/backend-services/src/protection/BranchProtectionPolicy';
import { isValidBranchName } from '../packages/shared/src/utils/BranchValidation';
import { sanitizeFilter, MAX_ISSUE_TITLE, MAX_ISSUE_BODY, ISSUE_STATUSES } from '../apps/api/src/workers/routes/IssueRoutes';
import { readJsonBody } from '../apps/api/src/workers/routes/BodyParser';
import { formatExpiryTimestamp, formatTimestamp } from '../apps/web/src/lib/format';
import { ReadModelService } from '../apps/background/src/ReadModelService';

describe('harden full sweep: shared concurrency', () => {
  it('preserves order under concurrency', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it('handles empty input without workers', async () => {
    await expect(mapWithConcurrency([], 10, async (x: number) => x)).resolves.toEqual([]);
  });

  it('caps concurrency at item count', async () => {
    let live = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3], 100, async (n) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 1));
      live -= 1;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('harden full sweep: wiki slug canonicalization', () => {
  it('SLUG_RE is the single charset source', () => {
    expect(SLUG_RE.test('my-team')).toBe(true);
    expect(SLUG_RE.test('-lead')).toBe(false);
  });

  it('slugify maps runs to hyphens, normalizeSlug alias delegates', () => {
    expect(WikiService.slugify('  Hello World  ')).toBe('hello-world');
    expect(WikiService.normalizeSlug('  Hello World  ')).toBe('hello-world');
  });
});

describe('harden full sweep: token listTokens batched', () => {
  it('enriches grants with one repo lookup per repo', async () => {
    const tokens = [
      { tokenId: 't1', userEmail: 'a@x.com', scopes: [] },
      { tokenId: 't2', userEmail: 'a@x.com', scopes: [] },
    ];
    const grants: Record<string, Array<{ token_id: string; repository_id: string; scope: 'repo:read' }>> = {
      t1: [
        { token_id: 't1', repository_id: 'r1', scope: 'repo:read' },
        { token_id: 't1', repository_id: 'r2', scope: 'repo:read' },
      ],
      t2: [{ token_id: 't2', repository_id: 'r1', scope: 'repo:read' }],
    };
    let repoCalls = 0;
    const svc = new TokenService(
      { DB: {} as never },
      {
        tokenDAO: () => Promise.resolve({ getByUserEmail: async () => tokens } as never),
        tokenGrantDAO: () => Promise.resolve({ listByToken: async (id: string) => grants[id] ?? [] } as never),
        repositoryDAO: () =>
          Promise.resolve({
            getById: async (id: string) => {
              repoCalls += 1;
              return { id, owner: 'o', name: id };
            },
          } as never),
      },
    );
    const out = await svc.listTokens('A@x.com');
    expect(out).toHaveLength(2);
    expect(out[0].repoGrants).toHaveLength(2);
    // Batched: 2 unique repos, not 3 sequential lookups.
    expect(repoCalls).toBe(2);
  });

  it('returns [] without DAO round-trips when no tokens', async () => {
    const grantList = vi.fn();
    const svc = new TokenService(
      { DB: {} as never },
      {
        tokenDAO: () => Promise.resolve({ getByUserEmail: async () => [] } as never),
        tokenGrantDAO: () => Promise.resolve({ listByToken: grantList } as never),
        repositoryDAO: () => Promise.resolve({ getById: vi.fn() } as never),
      },
    );
    await expect(svc.listTokens('a@x.com')).resolves.toEqual([]);
    expect(grantList).not.toHaveBeenCalled();
  });
});

describe('harden full sweep: webhook listHooks + fail-closed count', () => {
  it('fans out enrichment concurrently', async () => {
    const rows = [
      {
        id: 'h1',
        repository_id: 'r1',
        full_name: 'o/r',
        url: 'https://x',
        secret: 's',
        secret_suffix: 's',
        is_active: 1,
        consecutive_failures: 0,
        last_delivery_at: null,
        last_delivery_status: null,
        creator_email: 'a@x.com',
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 'h2',
        repository_id: 'r1',
        full_name: 'o/r',
        url: 'https://y',
        secret: 's',
        secret_suffix: 's',
        is_active: 1,
        consecutive_failures: 0,
        last_delivery_at: null,
        last_delivery_status: null,
        creator_email: 'a@x.com',
        created_at: 1,
        updated_at: 1,
      },
    ];
    const svc = new WebhookService(
      { DB: {} as never },
      {
        webhookDAO: () =>
          Promise.resolve({
            listByRepo: async () => rows,
            listEvents: async () => ['push'],
          } as never),
        userDAO: () => Promise.resolve({ getByEmail: async () => ({ username: 'alice' }) } as never),
      },
    );
    const out = await svc.listHooks('r1');
    expect(out).toHaveLength(2);
    expect(out[0].creator).toBe('alice');
  });

  it('fails closed when count cannot be read', async () => {
    const svc = new WebhookService(
      { DB: {} as never },
      {
        webhookDAO: () =>
          Promise.resolve({
            countByRepo: async () => {
              throw new Error('d1 down');
            },
          } as never),
      },
    );
    await expect(
      svc.createHook({ repositoryId: 'r1', fullName: 'o/r', url: 'https://example.com/hook', creatorEmail: 'a@x.com' }),
    ).rejects.toThrow();
  });
});

describe('harden full sweep: search batched visibility', () => {
  function searchDeps(repoById: Record<string, { id: string; is_private: number }>, roles: Record<string, string | null>) {
    return {
      searchDAO: () =>
        Promise.resolve({
          searchRepos: async () => [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }],
          searchIssues: async () => [{ repository_id: 'r1' }, { repository_id: 'r2' }],
          searchPulls: async () => [{ repository_id: 'r1' }],
          searchCode: async () => [{ repo_id: 'r1', content: 'hello world' }],
          searchDiscussions: async () => [{ repository_id: 'r2' }],
        } as never),
      repositoryDAO: () =>
        Promise.resolve({
          getById: async (id: string) => repoById[id] ?? null,
        } as never),
      permissionService: () =>
        Promise.resolve({
          getRole: async (_v: unknown, row: { id: string }) => roles[row.id] ?? null,
        } as never),
    };
  }

  it('searchRepos preserves order and limit', async () => {
    const svc = new SearchService(
      { DB: {} as never },
      searchDeps(
        { r1: { id: 'r1', is_private: 0 }, r2: { id: 'r2', is_private: 0 }, r3: { id: 'r3', is_private: 0 } },
        { r1: 'read', r2: null, r3: 'read' },
      ),
    );
    const out = await svc.searchRepos('ab', null, 2);
    expect(out.map((r) => (r as { id: string }).id)).toEqual(['r1', 'r3']);
  });

  it('searchIssues batches repo loads', async () => {
    let repoCalls = 0;
    const deps = searchDeps({ r1: { id: 'r1', is_private: 0 }, r2: { id: 'r2', is_private: 0 } }, { r1: 'read', r2: null });
    const origRepo = deps.repositoryDAO;
    deps.repositoryDAO = () =>
      origRepo().then(
        (dao) =>
          ({
            getById: async (id: string) => {
              repoCalls += 1;
              return (dao as { getById(id: string): Promise<unknown> }).getById(id);
            },
          }) as never,
      );
    const svc = new SearchService({ DB: {} as never }, deps);
    const out = await svc.searchIssues('ab', null);
    expect(out).toHaveLength(1);
    expect(repoCalls).toBe(2);
  });

  it('searchCode attaches snippets only for visible', async () => {
    const svc = new SearchService({ DB: {} as never }, searchDeps({ r1: { id: 'r1', is_private: 0 } }, { r1: 'read' }));
    const out = await svc.searchCode('hello', null);
    expect(out[0].snippet).toContain('hello');
  });
});

describe('harden full sweep: review-gate wrappers delegate', () => {
  it('PullRequestService wrappers match pure helpers', () => {
    const reviews = [{ author_email: 'a@x.com', state: 'changes_requested' }];
    expect(PullRequestService.isBlockedByReviews(reviews)).toBe(isBlockedByReviews(reviews));
    expect(PullRequestService.isValidBranchName('main')).toBe(isValidBranchName('main'));
  });

  it('BranchProtectionService.countApprovals matches policy', () => {
    const reviews = [{ author_email: 'b@x.com', state: 'approved' }];
    expect(BranchProtectionService.countApprovals(reviews, 'a@x.com')).toBe(countApprovals(reviews, 'a@x.com'));
  });
});

describe('harden full sweep: issue route validation', () => {
  it('sanitizeFilter trims, caps, rejects controls', () => {
    expect(sanitizeFilter(undefined)).toBeNull();
    expect(sanitizeFilter('   ')).toBeNull();
    expect(sanitizeFilter(' bug ')).toBe('bug');
    expect(sanitizeFilter('a'.repeat(200))).toHaveLength(100);
    expect(sanitizeFilter('a\u0000b')).toBeNull();
  });

  it('title/body caps and status allowlist are defined', () => {
    expect(MAX_ISSUE_TITLE).toBe(200);
    expect(MAX_ISSUE_BODY).toBe(10_000);
    expect(ISSUE_STATUSES.has('open')).toBe(true);
    expect(ISSUE_STATUSES.has('bogus')).toBe(false);
  });

  it('readJsonBody flags oversized content-length as 413 signal', async () => {
    const ctx = {
      req: {
        header: () => String(2_000_000),
        json: async () => ({}),
      },
    };
    const res = await readJsonBody(ctx as never);
    expect(res.oversized).toBe(true);
    expect(res.malformed).toBe(true);
  });

  it('readJsonBody rejects non-object JSON', async () => {
    const ctx = { req: { header: () => undefined, json: async () => [] } };
    const res = await readJsonBody(ctx as never);
    expect(res.malformed).toBe(true);
  });
});

describe('harden full sweep: web format + read model', () => {
  it('formatExpiryTimestamp never returns Never for numbers', () => {
    expect(formatTimestamp(null)).toBe('Never');
    expect(formatExpiryTimestamp(null)).toBe('Never');
    expect(formatExpiryTimestamp(4_000_000_000)).toMatch(/Expires/);
  });

  it('listAllFiles uses index pointer and caps', async () => {
    const git = {
      resolveRef: async () => 'abc',
      getTree: async (_ref: string, dir: string) =>
        dir === '' ? [{ path: 'a', type: 'tree', oid: '1' }] : [{ path: 'f', type: 'blob', oid: '2' }],
    };
    const svc = new ReadModelService(git as never);
    const files = await svc.listAllFiles({ ref: 'HEAD', maxFiles: 10 });
    expect(files).toEqual([{ path: 'a/f', oid: '2' }]);
  });

  it('overview README cap is 64KB (breaking reduction documented)', async () => {
    const big = { size: 100 * 1024, content: new Uint8Array([1, 2, 3]) };
    const git = {
      listBranches: async () => ['main'],
      currentBranch: async () => 'main',
      listTags: async () => [],
      resolveRef: async () => 'abc',
      getTree: async () => [{ path: 'README.md', type: 'blob', oid: 'x' }],
      getLastCommit: async () => ({ oid: 'abc' }),
      getLog: async () => [],
      getBlob: async () => big,
    };
    const svc = new ReadModelService(git as never);
    const overview = await svc.getOverview({});
    expect(overview.readme).toMatchObject({ path: 'README.md', truncated: true });
  });
});
