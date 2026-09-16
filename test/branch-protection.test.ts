import { describe, expect, it } from 'vitest';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BranchProtectionDAO } from '@edge-git/backend-data/dao';
import { BranchProtectionService } from '@edge-git/backend-services/protection';
import { branchNameFromRef, checkStaticPushProtection } from '@edge-git/git-protocol';

function createProtectionFakeDb(seedRules: Array<Record<string, unknown>> = []): D1Queryable & { rules: Array<Record<string, unknown>> } {
  const state = { rules: seedRules.map((r) => ({ ...r })) };
  function statement(query: string, params: unknown[]) {
    const q = query.replace(/\s+/g, ' ').trim();
    return {
      first<T>(): Promise<T | null> {
        if (q.startsWith('SELECT * FROM branch_protection_rules WHERE repository_id = ? AND pattern = ?')) {
          const row = state.rules.find((r) => r.repository_id === params[0] && r.pattern === params[1]);
          return Promise.resolve((row ?? null) as T | null);
        }
        if (q.startsWith('SELECT COUNT(*) AS n FROM branch_protection_rules WHERE repository_id = ?')) {
          return Promise.resolve({ n: state.rules.filter((r) => r.repository_id === params[0]).length } as unknown as T);
        }
        if (q.startsWith('SELECT') && q.includes('FROM branch_protection_rules WHERE id = ?')) {
          const row = state.rules.find((r) => r.id === params[0]);
          return Promise.resolve((row ?? null) as T | null);
        }
        return Promise.resolve(null);
      },
      all<T>(): Promise<{ results: T[] }> {
        if (q.startsWith('SELECT * FROM branch_protection_rules WHERE repository_id = ?')) {
          const rows = state.rules.filter((r) => r.repository_id === params[0]).sort((a, b) => String(a.pattern).localeCompare(String(b.pattern)));
          return Promise.resolve({ results: rows as T[] });
        }
        return Promise.resolve({ results: [] });
      },
      run(): Promise<{ success: boolean; meta?: { changes?: number } }> {
        if (q.startsWith('INSERT INTO branch_protection_rules')) {
          const [id, repository_id, pattern, require_pr, required_approvals, block_force_push, block_deletion, require_status_checks, created_by, created_at] =
            params as Array<string | number | null>;
          if (state.rules.some((r) => r.repository_id === repository_id && r.pattern === pattern)) {
            return Promise.resolve({ success: false, error: 'UNIQUE constraint failed' });
          }
          state.rules.push({ id, repository_id, pattern, require_pr, required_approvals, block_force_push, block_deletion, require_status_checks, created_by, created_at });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (q.startsWith('DELETE FROM branch_protection_rules WHERE id = ?')) {
          const before = state.rules.length;
          state.rules = state.rules.filter((r) => !(r.id === params[0] && r.repository_id === params[1]));
          return Promise.resolve({ success: true, meta: { changes: before - state.rules.length } });
        }
        if (q.startsWith('DELETE FROM branch_protection_rules WHERE repository_id = ?')) {
          const before = state.rules.length;
          state.rules = state.rules.filter((r) => r.repository_id !== params[0]);
          return Promise.resolve({ success: true, meta: { changes: before - state.rules.length } });
        }
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      },
    };
  }
  return { prepare: (query: string) => ({ bind: (...params: unknown[]) => statement(query, params) }), rules: state.rules } as unknown as D1Queryable & {
    rules: Array<Record<string, unknown>>;
  };
}

describe('BranchProtectionService pattern matching', () => {
  it('validates rule patterns', () => {
    expect(BranchProtectionService.isValidRulePattern('main')).toBe(true);
    expect(BranchProtectionService.isValidRulePattern('release/*')).toBe(true);
    expect(BranchProtectionService.isValidRulePattern('*')).toBe(true);
    expect(BranchProtectionService.isValidRulePattern('')).toBe(false);
    expect(BranchProtectionService.isValidRulePattern('has space')).toBe(false);
    expect(BranchProtectionService.isValidRulePattern('a//b')).toBe(false);
    expect(BranchProtectionService.isValidRulePattern('a/**/b')).toBe(false);
    expect(BranchProtectionService.isValidRulePattern('../escape')).toBe(false);
    expect(BranchProtectionService.isValidRulePattern('/leading')).toBe(false);
  });

  it('matches exact and glob patterns', () => {
    expect(BranchProtectionService.matchesPattern('main', 'main')).toBe(true);
    expect(BranchProtectionService.matchesPattern('main', 'main2')).toBe(false);
    expect(BranchProtectionService.matchesPattern('release/*', 'release/1.0')).toBe(true);
    expect(BranchProtectionService.matchesPattern('release/*', 'release')).toBe(false);
    expect(BranchProtectionService.matchesPattern('*', 'anything/at-all')).toBe(true);
    expect(BranchProtectionService.matchesPattern('*.x', 'a.x')).toBe(true);
  });

  it('prefers the longest matching pattern', () => {
    const rules = [
      { id: '1', repositoryId: 'r', pattern: '*', requirePr: false, requiredApprovals: 0, blockForcePush: true, blockDeletion: true, requireStatusChecks: [], createdBy: 'a', createdAt: 1 },
      { id: '2', repositoryId: 'r', pattern: 'release/*', requirePr: true, requiredApprovals: 1, blockForcePush: true, blockDeletion: true, requireStatusChecks: [], createdBy: 'a', createdAt: 1 },
    ];
    expect(BranchProtectionService.matchRule(rules, 'release/2.0')?.id).toBe('2');
    expect(BranchProtectionService.matchRule(rules, 'main')?.id).toBe('1');
    expect(BranchProtectionService.matchRule([], 'main')).toBeNull();
  });
});

describe('BranchProtectionService approvals', () => {
  const creator = 'creator@example.com';
  it('counts distinct approvers excluding the creator', () => {
    const reviews = [
      { author_email: creator, state: 'approved' },
      { author_email: 'a@example.com', state: 'approved' },
      { author_email: 'b@example.com', state: 'commented' },
    ];
    expect(BranchProtectionService.countApprovals(reviews, creator)).toBe(1);
  });

  it('uses the latest review per author', () => {
    const reviews = [
      { author_email: 'a@example.com', state: 'approved' },
      { author_email: 'a@example.com', state: 'changes_requested' },
    ];
    expect(BranchProtectionService.countApprovals(reviews, creator)).toBe(0);
  });

  it('blocks on change requests and enforces the quorum', () => {
    const rule = { id: 'r1', repositoryId: 'r', pattern: 'main', requirePr: true, requiredApprovals: 2, blockForcePush: true, blockDeletion: true, requireStatusChecks: [], createdBy: 'a', createdAt: 1 };
    const blocked = BranchProtectionService.checkMergeBlocked({
      rule,
      reviews: [{ author_email: 'a@example.com', state: 'changes_requested' }],
      creatorEmail: creator,
    });
    expect(blocked.blocked).toBe(true);
    const quorum = BranchProtectionService.checkMergeBlocked({
      rule,
      reviews: [{ author_email: 'a@example.com', state: 'approved' }],
      creatorEmail: creator,
    });
    expect(quorum).toMatchObject({ blocked: true });
    expect(quorum.reason).toContain('2 approvals (1 so far)');
    const ok = BranchProtectionService.checkMergeBlocked({
      rule,
      reviews: [
        { author_email: 'a@example.com', state: 'approved' },
        { author_email: 'b@example.com', state: 'approved' },
      ],
      creatorEmail: creator,
    });
    expect(ok).toEqual({ blocked: false, reason: null });
    expect(BranchProtectionService.checkMergeBlocked({ rule: null, reviews: [], creatorEmail: creator })).toEqual({ blocked: false, reason: null });
  });
});

describe('BranchProtectionService rules CRUD', () => {
  it('creates, lists, matches, and deletes rules', async () => {
    const db = createProtectionFakeDb();
    const svc = new BranchProtectionService({ DB: db });
    const created = await svc.createRule({ repositoryId: 'r1', pattern: 'main', requirePr: true, requiredApprovals: 1, createdBy: 'Admin@X.Co' });
    expect(created.pattern).toBe('main');
    expect(created.requirePr).toBe(true);
    expect(created.createdBy).toBe('admin@x.co');
    await expect(svc.listRules('r1')).resolves.toHaveLength(1);
    await expect(svc.matchForRepo('r1', 'main')).resolves.toMatchObject({ pattern: 'main' });
    await expect(svc.matchForRepo('r1', 'other')).resolves.toBeNull();
    await svc.deleteRule('r1', created.id);
    await expect(svc.listRules('r1')).resolves.toHaveLength(0);
  });

  it('forces requirePr when approvals are requested and stores status checks', async () => {
    const db = createProtectionFakeDb();
    const svc = new BranchProtectionService({ DB: db });
    const created = await svc.createRule({ repositoryId: 'r1', pattern: 'main', requiredApprovals: 2, requireStatusChecks: ['ci'], createdBy: 'a@x.co' });
    expect(created.requirePr).toBe(true);
    expect(created.requireStatusChecks).toEqual(['ci']);
  });

  it('rejects invalid patterns, approvals, duplicates, and over-limit repos', async () => {
    const db = createProtectionFakeDb();
    const svc = new BranchProtectionService({ DB: db, MAX_RULES_PER_REPO: '1' });
    await expect(svc.createRule({ repositoryId: 'r1', pattern: 'has space', createdBy: 'a@x.co' })).rejects.toThrow('pattern');
    await expect(svc.createRule({ repositoryId: 'r1', pattern: 'main', requiredApprovals: 7, createdBy: 'a@x.co' })).rejects.toThrow('requiredApprovals');
    await expect(svc.createRule({ repositoryId: 'r1', pattern: 'main', requireStatusChecks: 'ci', createdBy: 'a@x.co' })).rejects.toThrow('requireStatusChecks');
    await svc.createRule({ repositoryId: 'r1', pattern: 'main', createdBy: 'a@x.co' });
    await expect(svc.createRule({ repositoryId: 'r1', pattern: 'main', createdBy: 'a@x.co' })).rejects.toThrow('already exists');
    await expect(svc.createRule({ repositoryId: 'r1', pattern: 'other', createdBy: 'a@x.co' })).rejects.toThrow('Maximum 1');
  });
});

describe('push protection policy (wire level)', () => {
  const rule = { ref: 'refs/heads/main', requirePr: true, blockForcePush: true, blockDeletion: true };
  const oid = 'a'.repeat(40);
  const zero = '0'.repeat(40);
  it('extracts branch names only from heads refs', () => {
    expect(branchNameFromRef('refs/heads/main')).toBe('main');
    expect(branchNameFromRef('refs/heads/a/b')).toBe('a/b');
    expect(branchNameFromRef('refs/tags/v1')).toBeNull();
    expect(branchNameFromRef('refs/heads/')).toBeNull();
  });
  it('blocks deletions and direct pushes, allows creations', () => {
    expect(checkStaticPushProtection({ oldOid: oid, newOid: zero, ref: 'refs/heads/main' }, rule)).toContain('protected against deletion');
    expect(checkStaticPushProtection({ oldOid: oid, newOid: 'b'.repeat(40), ref: 'refs/heads/main' }, rule)).toContain('open a pull request');
    expect(checkStaticPushProtection({ oldOid: zero, newOid: oid, ref: 'refs/heads/main' }, rule)).toBeNull();
    expect(checkStaticPushProtection({ oldOid: oid, newOid: oid, ref: 'refs/heads/main' }, { ...rule, requirePr: false, blockDeletion: false })).toBeNull();
    expect(checkStaticPushProtection({ oldOid: oid, newOid: zero, ref: 'refs/tags/v1' }, { ...rule, ref: 'refs/tags/v1' })).toBeNull();
    expect(checkStaticPushProtection({ oldOid: oid, newOid: 'b'.repeat(40), ref: 'refs/heads/main' }, undefined)).toBeNull();
  });
});

describe('BranchProtectionDAO', () => {
  it('round-trips rules and deletes by repo', async () => {
    const db = createProtectionFakeDb();
    const dao = new BranchProtectionDAO(db);
    await dao.create({
      id: 'r1',
      repositoryId: 'repo1',
      pattern: 'main',
      requirePr: true,
      requiredApprovals: 1,
      blockForcePush: true,
      blockDeletion: false,
      requireStatusChecks: ['ci'],
      createdBy: 'A@x.co',
      now: 100,
    });
    await expect(dao.listByRepo('repo1')).resolves.toHaveLength(1);
    await expect(dao.getByRepoAndPattern('repo1', 'main')).resolves.toMatchObject({ requirePr: true, blockDeletion: false, requireStatusChecks: ['ci'] });
    await expect(dao.countByRepo('repo1')).resolves.toBe(1);
    await dao.deleteByRepo('repo1');
    await expect(dao.listByRepo('repo1')).resolves.toHaveLength(0);
  });
});
