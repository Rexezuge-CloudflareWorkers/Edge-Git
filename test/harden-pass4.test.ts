import { describe, expect, it, vi } from 'vitest';
import { buildSetClause } from '@edge-git/backend-data/dao';
import { buildScopedLikeStatement } from '../packages/backend-data/src/dao/SearchQueries';
import { CollaborationQueries } from '../packages/backend-data/src/dao/CollaborationQueries';
import { assertNotLastOrgOwner, assertNotLastTeamAdmin } from '../packages/backend-services/src/policy/MembershipPolicy';
import {
  checkRepoQuota,
  classifyCreatePath,
  throwIfForbidden,
  validateRepoPatch,
} from '../packages/backend-services/src/repo/RepoCreatePolicy';
import { RepoServiceDepsBuilder } from '../packages/backend-services/src/repo/RepoServiceDepsBuilder';
import { providerOf } from '../packages/backend-runtime/src/di/Provider';
import { Tokens } from '@edge-git/backend-services/composition';
import { DomainEventBus } from '../packages/backend-services/src/events/DomainEventBus';
import {
  CHECK_SHA_RE,
  handleAuditRecord,
  handleCheckUpdated,
  handleRealtimePublish,
  handleWebhookEmit,
  registerDomainEventDefaults,
} from '../packages/backend-services/src/events/transportSubscribers';
import type { Container } from '@edge-git/backend-runtime/di';
import { probeCodeownerCandidates, treeHasCandidate } from '@/workers/routes/CodeownerHelpers';
import { countVisibleRepos, deduplicateRepoRows, filterVisibleOrgUsernames } from '@/workers/routes/UserProfileVisibility';
import { selectUntaggedTags } from '../apps/web/src/components/repo/useReleases';

/**
 * Hardening pass 4: covers the extracted specifications/policies/builders
 * plus the DomainEventBus mediator and the web/route splits.
 */
describe('pass4: UpdateClause builder', () => {
  it('builds SET clauses preserving assignment order', () => {
    expect(buildSetClause([])).toEqual({ clause: '', values: [] });
    expect(
      buildSetClause([
        { column: 'updated_at', value: 7 },
        { column: 'description', value: 'hi' },
        { column: 'is_private', value: 1 },
      ]),
    ).toEqual({ clause: 'updated_at = ?, description = ?, is_private = ?', values: [7, 'hi', 1] });
  });
});

describe('pass4: scoped LIKE statement', () => {
  const base = {
    table: 'issues',
    scopeColumn: 'repository_id',
    columns: ['lower(title)'],
    tokenCount: 2,
    scopedOrderBy: 'number DESC',
    unscopedOrderBy: 'updated_at DESC',
  };

  it('builds the scoped template with scope-first bind order', () => {
    const like = buildScopedLikeStatement({ ...base, scopeValue: 'r1' });
    expect(like.scoped).toBe(true);
    expect(like.text).toContain('WHERE repository_id = ? AND');
    expect(like.text).toContain('ORDER BY number DESC LIMIT ?');
  });

  it('builds the unscoped template without a scope predicate', () => {
    const like = buildScopedLikeStatement(base);
    expect(like.scoped).toBe(false);
    expect(like.text).not.toContain('repository_id = ?');
    expect(like.text).toContain('ORDER BY updated_at DESC LIMIT ?');
  });
});

describe('pass4: CollaborationQueries consolidation', () => {
  it('open-milestone insert matches the DAO six-bind form', () => {
    expect(CollaborationQueries.insertMilestoneOpen()).toContain("'open'");
    expect(CollaborationQueries.insertMilestoneOpen().split('?')).toHaveLength(7);
  });

  it('reviewer helpers preserve ignore vs overwrite semantics', () => {
    expect(CollaborationQueries.insertReviewerIgnore()).toContain('INSERT OR IGNORE');
    expect(CollaborationQueries.listReviewersByEmail()).toContain('ORDER BY user_email ASC');
    expect(CollaborationQueries.upsertReviewer()).toContain('ON CONFLICT');
  });
});

describe('pass4: MembershipPolicy guards', () => {
  it('rejects demoting/removing the last privileged member', () => {
    expect(() => assertNotLastTeamAdmin('admin', 1, 'demote')).toThrow(/last team admin/);
    expect(() => assertNotLastTeamAdmin('admin', 1, 'remove')).toThrow(/last team admin/);
    expect(() => assertNotLastOrgOwner('owner', 1, 'demote')).toThrow(/last owner/);
    expect(() => assertNotLastOrgOwner('owner', 1, 'remove')).toThrow(/last owner/);
  });

  it('allows non-privileged transitions and healthy counts', () => {
    expect(() => assertNotLastTeamAdmin('member', 1, 'demote')).not.toThrow();
    expect(() => assertNotLastTeamAdmin('admin', 2, 'demote')).not.toThrow();
    expect(() => assertNotLastTeamAdmin('admin', 2, 'remove')).not.toThrow();
    expect(() => assertNotLastOrgOwner('member', 1, 'remove')).not.toThrow();
    expect(() => assertNotLastOrgOwner('owner', 3, 'demote')).not.toThrow();
  });
});

describe('pass4: RepoCreatePolicy', () => {
  it('validates patches and quotas', () => {
    expect(() => validateRepoPatch({ description: 'x'.repeat(501) })).toThrow(/500/);
    expect(() => validateRepoPatch({ isPrivate: 'yes' as unknown as boolean })).toThrow(/boolean/);
    expect(() => validateRepoPatch({ description: null, isPrivate: true })).not.toThrow();
    expect(() => checkRepoQuota(5, 5)).toThrow(/Maximum 5/);
    expect(() => checkRepoQuota(4, 5)).not.toThrow();
  });

  it('classifies self before org before legacy', () => {
    expect(
      classifyCreatePath({
        ownerCi: 'alice',
        callerCi: 'alice',
        org: { id: 'o', username: 'alice' },
        isOrgMember: false,
        namespaceOwnerEmail: null,
        callerEmail: 'alice@x.com',
      }),
    ).toEqual({ kind: 'self' });
    expect(
      classifyCreatePath({
        ownerCi: 'acme',
        callerCi: 'alice',
        org: { id: 'o', username: 'acme' },
        isOrgMember: true,
        namespaceOwnerEmail: null,
        callerEmail: 'alice@x.com',
      }),
    ).toEqual({ kind: 'org', orgId: 'o', owner: 'acme' });
    expect(
      classifyCreatePath({
        ownerCi: 'acme',
        callerCi: 'alice',
        org: { id: 'o', username: 'acme' },
        isOrgMember: false,
        namespaceOwnerEmail: null,
        callerEmail: 'alice@x.com',
      }).kind,
    ).toBe('forbidden');
    expect(
      classifyCreatePath({
        ownerCi: 'bob',
        callerCi: 'alice',
        org: null,
        isOrgMember: false,
        namespaceOwnerEmail: 'bob@x.com',
        callerEmail: 'alice@x.com',
      }).kind,
    ).toBe('forbidden');
    expect(
      classifyCreatePath({
        ownerCi: 'free',
        callerCi: 'alice',
        org: null,
        isOrgMember: false,
        namespaceOwnerEmail: null,
        callerEmail: 'alice@x.com',
      }),
    ).toEqual({ kind: 'legacy' });
  });

  it('throwIfForbidden narrows the union', () => {
    expect(() => throwIfForbidden({ kind: 'forbidden', reason: 'nope' })).toThrow('nope');
    expect(() => throwIfForbidden({ kind: 'self' })).not.toThrow();
  });
});

describe('pass4: RepoServiceDepsBuilder', () => {
  const env = { DB: {} } as never;

  it('fails fast on missing load-bearing DAOs', () => {
    expect(() => RepoServiceDepsBuilder.fromEnv(env).build()).toThrow(/repositoryDAO/);
    expect(() =>
      RepoServiceDepsBuilder.fromEnv(env)
        .with('repositoryDAO', providerOf({} as never))
        .build(),
    ).toThrow(/userDAO/);
  });

  it('builds with defaults from env', () => {
    const deps = RepoServiceDepsBuilder.fromEnv(env)
      .with('repositoryDAO', providerOf({} as never))
      .with('userDAO', providerOf({} as never))
      .build();
    expect(typeof deps.repositoryDAO).toBe('function');
    expect(typeof deps.userDAO).toBe('function');
    expect(deps.config.getMaxReposPerUser()).toBeGreaterThan(0);
  });

  it('accepts the whole DAO bundle at once', async () => {
    const deps = RepoServiceDepsBuilder.fromEnv(env)
      .withDaos({ repositoryDAO: providerOf({} as never), userDAO: providerOf({} as never) })
      .withPermissionService(providerOf({} as never))
      .build();
    expect(await deps.repositoryDAO()).toEqual({});
  });

  it('providerOf lifts values into providers', async () => {
    expect(await providerOf(42)()).toBe(42);
  });
});

describe('pass4: DomainEventBus mediator', () => {
  it('routes by type and supports unsubscribe', async () => {
    const bus = new DomainEventBus();
    const seen: string[] = [];
    const off = bus.on('audit.record', () => void seen.push('audit'));
    bus.on('webhook.emit', () => void seen.push('webhook'));
    expect(bus.size).toBe(2);
    await bus.emit({ type: 'audit.record', event: {} as never });
    off();
    expect(bus.size).toBe(1);
    await bus.emit({ type: 'audit.record', event: {} as never });
    expect(seen).toEqual(['audit']);
  });

  it('never throws on handler failure', async () => {
    const bus = DomainEventBus.withHandlers([
      {
        type: 'realtime.publish',
        handler: () => Promise.reject(new Error('boom')),
      },
    ]);
    await expect(
      bus.emit({ type: 'realtime.publish', input: {} as never, via: { publishToShard: async () => undefined } }),
    ).resolves.toBeUndefined();
  });

  it('registers four default transports', () => {
    const container = {
      get: () => {
        throw new Error('unused');
      },
    } as unknown as Container;
    const bus = registerDomainEventDefaults(new DomainEventBus(), container);
    expect(bus.size).toBe(4);
  });
});

describe('pass4: transport subscribers', () => {
  function fakeContainer(services: Record<symbol, unknown>): Container {
    return {
      get: (token: unknown) => {
        const svc = services[token as symbol];
        if (svc === undefined) throw new Error(`unbound ${String(token)}`);
        return svc;
      },
    } as unknown as Container;
  }

  it('audit subscriber delegates to AuditService', async () => {
    const record = vi.fn(async () => undefined);
    const container = fakeContainer({ [Tokens.AuditService]: { record } });
    await handleAuditRecord(container, { action: 'x' } as never);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('webhook subscriber falls back to ghost on resolver failure', async () => {
    const enqueueForEvent = vi.fn(async () => ({ enqueued: 1 }));
    const container = fakeContainer({
      [Tokens.IdentityResolver]: {
        resolveUsername: async () => {
          throw new Error('down');
        },
      },
      [Tokens.WebhookDeliveryService]: { enqueueForEvent },
    });
    await handleWebhookEmit(container, {
      repositoryId: 'r',
      fullName: 'a/b',
      actorEmail: 'a@x.com',
      event: 'push',
    } as never);
    expect(enqueueForEvent).toHaveBeenCalledWith(expect.objectContaining({ actorUsername: 'ghost' }));
  });

  it('realtime subscriber respects the disabled guard and channels', async () => {
    const publishToShard = vi.fn(async () => undefined);
    const enabled = fakeContainer({ [Tokens.AppConfig]: { isRealtimeEnabled: () => true } });
    const disabled = fakeContainer({ [Tokens.AppConfig]: { isRealtimeEnabled: () => false } });
    const input = {
      fullName: 'a/b',
      channel: 'activity',
      type: 'push',
      actorEmail: 'a@x.com',
      title: 't',
      recipientEmails: [],
    } as never;
    await handleRealtimePublish(disabled, input, publishToShard);
    expect(publishToShard).not.toHaveBeenCalled();
    await handleRealtimePublish(enabled, { ...input, channel: '' } as never, publishToShard);
    expect(publishToShard).not.toHaveBeenCalled();
    await handleRealtimePublish(enabled, input, publishToShard);
    expect(publishToShard).toHaveBeenCalledTimes(1);
    expect(publishToShard.mock.calls[0][0]).toBe('repo:a/b');
  });

  it('check subscriber validates SHAs and builds per-SHA channels', async () => {
    expect(CHECK_SHA_RE.test('abc123')).toBe(true);
    expect(CHECK_SHA_RE.test('nope!')).toBe(false);
    const publishToShard = vi.fn(async () => undefined);
    const container = fakeContainer({ [Tokens.AppConfig]: { isRealtimeEnabled: () => true } });
    await handleCheckUpdated(
      container,
      { fullName: 'a/b', headSha: 'zzz', context: 'c', status: 's', actorEmail: 'a@x.com' } as never,
      publishToShard,
    );
    expect(publishToShard).not.toHaveBeenCalled();
    await handleCheckUpdated(
      container,
      { fullName: 'a/b', headSha: 'ABC123', context: 'c', status: 's', actorEmail: 'a@x.com' } as never,
      publishToShard,
    );
    expect(publishToShard.mock.calls[0][0]).toBe('repo:a/b');
    expect(publishToShard.mock.calls[0][1]).toMatchObject({ channel: 'checks:abc123', type: 'check_run.updated' });
  });
});

describe('pass4: CODEOWNERS probe helpers', () => {
  it('probes candidates in order and parses the first hit', async () => {
    const b64 = Buffer.from('* @alice\n', 'utf8').toString('base64');
    const stub = {
      getBlob: async ({ filepath }: { filepath: string }) =>
        filepath === '.github/CODEOWNERS' ? { contentBase64: b64 } : Promise.reject(new Error('miss')),
    };
    const rules = await probeCodeownerCandidates(stub, 'main');
    expect(rules).toHaveLength(1);
    expect(rules[0].owners).toContain('@alice');
  });

  it('returns [] when nothing matches', async () => {
    const stub = { getBlob: async () => Promise.reject(new Error('miss')) };
    expect(await probeCodeownerCandidates(stub, 'main')).toEqual([]);
  });

  it('treeHasCandidate checks root and subdirectory listings', async () => {
    const stub = {
      getBlob: async () => null,
      getTree: async ({ path }: { path?: string }) =>
        path === undefined ? [{ path: 'CODEOWNERS' }, { path: '.github' }] : [{ path: 'CODEOWNERS' }],
    };
    const root = new Set(['CODEOWNERS', '.github']);
    expect(await treeHasCandidate(stub, 'main', root, 'CODEOWNERS')).toBe(true);
    expect(await treeHasCandidate(stub, 'main', root, '.github/CODEOWNERS')).toBe(true);
    expect(await treeHasCandidate(stub, 'main', root, 'docs/CODEOWNERS')).toBe(false);
  });
});

describe('pass4: profile visibility unification', () => {
  const rows = [
    { id: '1', is_private: 0 },
    { id: '2', is_private: 1 },
  ] as never[];

  it('countVisibleRepos shares the filter shape', async () => {
    expect(await countVisibleRepos(rows, null, async () => 'read')).toBe(2);
    expect(await countVisibleRepos(rows, null, async () => null)).toBe(0);
  });

  it('filterVisibleOrgUsernames prefers membership then visible repos', async () => {
    const orgs = [
      { id: 'o1', username: 'member-org' },
      { id: 'o2', username: 'repo-org' },
      { id: 'o3', username: 'hidden-org' },
    ];
    const visible = await filterVisibleOrgUsernames(orgs, 'v@x.com', {
      getMemberRole: async (orgId) => (orgId === 'o1' ? 'member' : null),
      listByOrgId: async (orgId) => (orgId === 'o2' ? rows : []),
      getRole: async (_viewer, repo) => ((repo as { id: string }).id === '1' ? 'read' : null),
    });
    expect(visible).toEqual(['member-org', 'repo-org']);
    expect(deduplicateRepoRows([{ id: '1' }], [{ id: '1' }, { id: '2' }]).map((r) => r.id)).toEqual(['1', '2']);
  });
});

describe('pass4: web pure slices', () => {
  it('selectUntaggedTags filters matched tags', () => {
    const tags = [
      { name: 'v1', ref: 'refs/tags/v1' },
      { name: 'v2', ref: 'refs/tags/v2' },
    ] as never[];
    const releases = [{ tagName: 'v1' }] as never[];
    expect(selectUntaggedTags(tags, releases).map((t) => t.name)).toEqual(['v2']);
    expect(selectUntaggedTags([], releases)).toEqual([]);
  });
});
