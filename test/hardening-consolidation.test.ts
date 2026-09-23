import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isValidBranchName as sharedIsValid } from '@edge-git/shared/utils';
import { isValidBranchName as refValidationIsValid } from '../packages/git-service/src/RefValidation';
import { PackLimitError as LimitsError, checkObjectBudget, maxVisitedFor } from '../packages/git-service/src/PackLimits';
import { PackLimitError as CollectorError } from '../packages/git-service/src/PackCollector';
// NOTE: the package barrel (`src/index.ts`) re-exports the `dofs` runtime
// (unparsable `cloudflare:*` in the node pool), so barrel identity is
// asserted statically in `test/hardening-consolidation-barrel.test.ts` via
// source scan instead of a runtime import here.
import { ErrorNormalizer } from '../packages/git-service/src/ErrorNormalizer';
import { MergeService } from '../packages/git-service/src/MergeService';
import { cleanupRepoSidecars } from '../packages/backend-services/src/repo/repoCleanup';
import { WebhookDeliveryService } from '../packages/backend-services/src/webhook/WebhookDeliveryService';

describe('hardening consolidation (single canonical paths)', () => {
  it('exposes one isValidBranchName identity via shared and RefValidation', () => {
    expect(refValidationIsValid).toBe(sharedIsValid);
    expect(refValidationIsValid('main')).toBe(true);
    expect(refValidationIsValid('')).toBe(false);
  });

  it('exposes one PackLimitError identity via PackLimits and PackCollector', () => {
    expect(CollectorError).toBe(LimitsError);
    expect(new LimitsError('too many').name).toBe('PackLimitError');
  });

  it('enforces pack budgets via pure helpers', () => {
    expect(() => checkObjectBudget({ objectsToSend: 11, visited: 1, maxObjects: 10, maxVisited: 1000 })).toThrowError(LimitsError);
    expect(() => checkObjectBudget({ objectsToSend: 1, visited: 1, maxVisited: 100 })).not.toThrow();
    expect(maxVisitedFor(10)).toBe(10 * 4 + 1000);
  });

  it('ErrorNormalizer preserves codes, extracts from messages, defaults to ENOENT', () => {
    const normalizer = new ErrorNormalizer();
    const preserved = normalizer.ensureErrCode(Object.assign(new Error('boom'), { code: 'ENOSPC' }));
    expect(preserved.code).toBe('ENOSPC');
    expect(normalizer.ensureErrCode(new Error('EACCES')).code).toBe('EACCES');
    expect(normalizer.ensureErrCode(new Error('mystery failure')).code).toBe('ENOENT');
  });
});

describe('MergeService shared preamble (Template Method)', () => {
  function serviceWithResolve(result: string | null) {
    const svc = new MergeService({} as never, '/gitdir-test');
    vi.spyOn(svc, 'resolveRef').mockResolvedValue(result);
    vi.spyOn(svc, 'findMergeBase').mockResolvedValue(null);
    return svc;
  }

  it('rejects invalid branch and oid before touching the repo', async () => {
    const svc = serviceWithResolve('a'.repeat(40));
    await expect(
      svc.squashMerge({ baseBranch: 'bad..name', headOid: 'b'.repeat(40), author: { name: 'a', email: 'a@x.y' } }),
    ).rejects.toThrow('invalid base branch');
    await expect(svc.rebaseMerge({ baseBranch: 'main', headOid: 'short', author: { name: 'a', email: 'a@x.y' } })).rejects.toThrow(
      'invalid head oid',
    );
    await expect(svc.mergeBranches({ baseBranch: 'main', headOid: 'short', author: { name: 'a', email: 'a@x.y' } })).rejects.toThrow(
      'invalid head oid',
    );
  });

  it('reports missing base branch from the shared preamble', async () => {
    const svc = serviceWithResolve(null);
    await expect(svc.squashMerge({ baseBranch: 'main', headOid: 'b'.repeat(40), author: { name: 'a', email: 'a@x.y' } })).rejects.toThrow(
      'base branch not found',
    );
  });

  it('short-circuits already-merged heads without reading commits', async () => {
    const oid = 'a'.repeat(40);
    const svc = serviceWithResolve(oid);
    await expect(svc.squashMerge({ baseBranch: 'main', headOid: oid, author: { name: 'a', email: 'a@x.y' } })).resolves.toEqual({
      type: 'already-merged',
      commitOid: oid,
    });
    await expect(svc.rebaseMerge({ baseBranch: 'main', headOid: oid, author: { name: 'a', email: 'a@x.y' } })).resolves.toEqual({
      type: 'already-merged',
      commitOid: oid,
    });
    await expect(svc.mergeBranches({ baseBranch: 'main', headOid: oid, author: { name: 'a', email: 'a@x.y' } })).resolves.toEqual({
      type: 'already-merged',
      commitOid: oid,
    });
  });
});

describe('best-effort paths stay silent-safe but observable', () => {
  it('cleanupRepoSidecars ignores legacy missing tables and warns on real failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const ok = () => Promise.resolve({ deleteByRepo: () => Promise.resolve() });
      await cleanupRepoSidecars(
        {
          issueDAO: ok,
          pullRequestDAO: () => Promise.resolve({ deleteByRepo: () => Promise.reject(new Error('no such table: x')) }),
          pullThreadDAO: ok,
          branchProtectionDAO: ok,
          repoCollaboratorDAO: ok,
          starDAO: ok,
          watchDAO: ok,
          eventDAO: ok,
          notificationDAO: ok,
          releaseDAO: ok,
          projectDAO: ok,
          discussionDAO: ok,
          wikiDAO: ok,
          importDAO: ok,
          mirrorDAO: ok,
          deployKeyDAO: ok,
          tokenGrantDAO: ok,
          securitySettingsDAO: ok,
          collaborationDAO: ok,
          webhookDAO: ok,
          webhookDeliveryDAO: ok,
          auditLogDAO: ok,
          teamGrantDAO: ok,
          checkRunDAO: ok,
          numberingDAO: ok,
          searchDAO: ok,
        } as never,
        'repo-1',
      );
      expect(warn).not.toHaveBeenCalled();
      await cleanupRepoSidecars(
        {
          issueDAO: ok,
          pullRequestDAO: () => Promise.resolve({ deleteByRepo: () => Promise.reject(new Error('D1 outage')) }),
          pullThreadDAO: ok,
          branchProtectionDAO: ok,
          repoCollaboratorDAO: ok,
          starDAO: ok,
          watchDAO: ok,
          eventDAO: ok,
          notificationDAO: ok,
          releaseDAO: ok,
          projectDAO: ok,
          discussionDAO: ok,
          wikiDAO: ok,
          importDAO: ok,
          mirrorDAO: ok,
          deployKeyDAO: ok,
          tokenGrantDAO: ok,
          securitySettingsDAO: ok,
          collaborationDAO: ok,
          webhookDAO: ok,
          webhookDeliveryDAO: ok,
          auditLogDAO: ok,
          teamGrantDAO: ok,
          checkRunDAO: ok,
          numberingDAO: ok,
          searchDAO: ok,
        } as never,
        'repo-1',
      );
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('enqueueForEvent degrades to zero but warns on DAO outage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const svc = new WebhookDeliveryService(
        { DB: {} as never },
        {
          webhookDAO: () => Promise.reject(new Error('D1 down')),
          deliveryDAO: () => Promise.reject(new Error('D1 down')),
        },
      );
      await expect(svc.enqueueForEvent({ repositoryId: 'r', fullName: 'o/r', event: 'push' })).resolves.toEqual({
        enqueued: 0,
      });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('processDue degrades to zero counters but warns on listDue outage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const svc = new WebhookDeliveryService(
        { DB: {} as never },
        {
          deliveryDAO: () =>
            Promise.resolve({
              listDue: () => Promise.reject(new Error('D1 down')),
              claim: () => Promise.resolve(true),
            } as never),
        },
      );
      await expect(svc.processDue({ now: 1 })).resolves.toEqual({ processed: 0, succeeded: 0, failed: 0 });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('barrel re-exports from canonical modules (no MergeService/GitService hops)', () => {
    const barrel = fs.readFileSync(path.join(__dirname, '..', 'packages', 'git-service', 'src', 'index.ts'), 'utf8');
    expect(barrel).toContain('isValidBranchName');
    expect(barrel).toContain("from './RefValidation'");
    expect(barrel).toContain('PackLimitError');
    expect(barrel).toContain("from './PackLimits'");
    // Must not re-export those symbols from the old hops (exact re-export lines).
    expect(barrel).not.toContain("isValidBranchName } from './MergeService");
    expect(barrel).not.toContain("isValidBranchName} from './MergeService");
    expect(barrel).not.toContain("PackLimitError } from './PackCollector");
    expect(barrel).not.toContain("PackLimitError } from './GitService");
    expect(barrel).not.toContain("PackLimitError} from './PackCollector");
    expect(barrel).not.toContain("PackLimitError} from './GitService");
    const gitService = fs.readFileSync(path.join(__dirname, '..', 'packages', 'git-service', 'src', 'GitService.ts'), 'utf8');
    expect(gitService).not.toMatch(/export \{ PackLimitError \}/);
    const mergeService = fs.readFileSync(path.join(__dirname, '..', 'packages', 'git-service', 'src', 'MergeService.ts'), 'utf8');
    expect(mergeService).not.toMatch(/export \{ isValidBranchName \}/);
    expect(mergeService).toMatch(/resolveMergeBase/);
  });

  it('profile limit parser delegates to BaseRoute with default 20', async () => {
    const { BaseRoute } = await import('@/endpoints/IBaseRoute');
    const { parseLimit } = await import('@/workers/routes/UserProfileVisibility');
    for (const url of [
      'https://x/?limit=abc',
      'https://x/?limit=',
      'https://x/?limit=  ',
      'https://x/',
      'https://x/?limit=0',
      'https://x/?limit=500',
      'https://x/?limit=25',
    ]) {
      expect(parseLimit(url)).toBe(BaseRoute.parseLimit(url, 20, 100));
    }
    expect(parseLimit('https://x/?limit=abc')).toBe(20);
    expect(parseLimit('https://x/?limit=500')).toBe(100);
  });

  it('BaseRoute.parseLimit trims whitespace and falls back to def', async () => {
    const { BaseRoute } = await import('@/endpoints/IBaseRoute');
    expect(BaseRoute.parseLimit('https://x/?limit= 20 ', 100, 100)).toBe(20);
    expect(BaseRoute.parseLimit('https://x/?limit=   ', 100, 100)).toBe(100);
    expect(BaseRoute.parseLimit('https://x/?limit=abc', 100, 100)).toBe(100);
    expect(BaseRoute.parseLimit('not a url', 7, 100)).toBe(7);
  });

  it('web locale module has no orphan wrappers or unused formatters', () => {
    const locale = fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', 'src', 'lib', 'locale.ts'), 'utf8');
    expect(locale).not.toMatch(/canonicalizeLocaleTag\(tag: string\): string/);
    expect(locale).not.toContain('formatTimeLocale');
    expect(locale).not.toContain('formatNumberLocale');
    expect(locale).toContain('canonicalizeLanguageTag(tag)');
  });
});
