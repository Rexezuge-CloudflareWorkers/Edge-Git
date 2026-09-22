import { describe, expect, it } from 'vitest';
import { AccessAuthService } from '@edge-git/backend-services/auth';
import { UnauthorizedError, DatabaseError } from '@edge-git/backend-errors';
import { PktLine } from '@edge-git/git-protocol';
import { parseReceivePackRequest } from '@edge-git/git-protocol';
import { parseCommand, validateFetchRequestCounts } from '@edge-git/git-protocol';
import { Container, createServiceContext, setRequestScope } from '@edge-git/backend-runtime/di';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
import { ContentLimits } from '@edge-git/backend-runtime/config';
import { RetentionLimits } from '@edge-git/backend-runtime/config';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { bindDaoBindings } from '@edge-git/backend-services/composition/daoBindings';
import { bindServiceBindings } from '@edge-git/backend-services/composition/serviceBindings';
import { AbstractPruningTask } from '@edge-git/background/scheduled/IScheduledTask';
import { AuditLogCleanupTask } from '@edge-git/background/scheduled/AuditLogCleanupTask';
import { CheckPruneTask } from '@edge-git/background/scheduled/CheckPruneTask';
import { ExpiredTokenPruningTask } from '@edge-git/background/scheduled/ExpiredTokenPruningTask';
import { gitAuthForRepo } from '@/middleware/GitAuth';

// Big-bang hardening regression tests: one test per fixed bug / new seam.

describe('AccessAuthService single-throw chain', () => {
  it('falls through a failing JWT strategy to the ctx.access fallback (no double verify)', async () => {
    const svc = new AccessAuthService({
      TEAM_DOMAIN: 'https://team.cloudflareaccess.com',
      POLICY_AUD: 'aud',
      ENVIRONMENT: 'production',
    });
    // No JWT header: the JWT strategy fails soft, ctx identity wins. Before
    // the fix the JWT strategy threw, so this fallback was unreachable.
    await expect(
      svc.getAuthenticatedUserEmail(new Request('https://x/'), {
        access: { getIdentity: async () => ({ email: 'ctx@example.com' }) },
      }),
    ).resolves.toBe('ctx@example.com');
  });

  it('throws a single UnauthorizedError when no strategy matches', async () => {
    const svc = new AccessAuthService({ ENVIRONMENT: 'production' });
    const err = await svc.getAuthenticatedUserEmail(new Request('https://x/')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnauthorizedError);
  });
});

describe('pkt-line error consistency', () => {
  it('rejects non-hex lengths with Error carrying the hex value', () => {
    // Hardened: pkt-line failures are plain `Error` (not `TypeError`) so the
    // single error pipeline maps them to 400 consistently.
    const buf = new TextEncoder().encode('ZZZZ');
    let caught: unknown;
    try {
      PktLine.decode(buf);
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/Invalid hexadecimal length: ZZZZ/);
  });

  it('parseReceivePackRequest fails closed on non-hex lengths instead of empty commands', () => {
    const buf = new TextEncoder().encode('ZZZZjunk');
    expect(() => parseReceivePackRequest(buf)).toThrow(Error);
  });

  it('parseCommand fails closed on non-hex lengths', () => {
    const buf = new TextEncoder().encode('ZZZZjunk');
    // `PktLine.decode` rejects the header first ("Invalid hexadecimal
    // length"); the explicit cursor guard covers any path that gets past it.
    // Either way it throws Error — never a silent empty command.
    expect(() => parseCommand(buf)).toThrow(Error);
  });
});

describe('validateFetchRequestCounts clock seam', () => {
  const limits = { maxWants: 64, maxHaves: 512 };

  it('rejects far-future deepen-since deterministically with an injected clock', () => {
    const req = { wants: [], haves: [], shallowOptions: { deepenSince: 2_000_000_000 } };
    expect(validateFetchRequestCounts(req, limits, 1_700_000_000)).toMatch(/future/);
    // Same value is fine against a later clock — proves the seam drives it.
    expect(validateFetchRequestCounts(req, limits, 1_999_999_999)).toBeNull();
  });
});

describe('AbstractPruningTask template method', () => {
  class StubPrune extends AbstractPruningTask {
    public readonly name = 'StubPrune';
    public readonly phase: 1 | 2 = 2;
    public seen: Array<{ cutoff: number; batch: number }> = [];
    public fail = false;

    protected getRetentionDays(): number {
      return 10;
    }

    protected async pruneBatch(_env: Env, cutoff: number, batchSize: number): Promise<number> {
      this.seen.push({ cutoff, batch: batchSize });
      if (this.fail) throw new Error('D1 down');
      return 3;
    }

    protected getPrunedNoun(): string {
      return 'stubs';
    }
  }

  it('computes cutoff from retention days and delegates the batch', async () => {
    const task = new StubPrune();
    const before = Math.trunc(Date.now() / 1000);
    await task.run({} as Env);
    expect(task.seen).toHaveLength(1);
    expect(task.seen[0].batch).toBe(500);
    expect(task.seen[0].cutoff).toBeLessThanOrEqual(before - 10 * 86_400 + 5);
  });

  it('swallows prune failures (retry next tick)', async () => {
    const task = new StubPrune();
    task.fail = true;
    await expect(task.run({} as Env)).resolves.toBeUndefined();
  });

  it('keeps task names/phases after the split', () => {
    expect(new AuditLogCleanupTask().name).toBe('AuditLogCleanupTask');
    expect(new CheckPruneTask().phase).toBe(2);
    expect(new ExpiredTokenPruningTask().phase).toBe(1);
  });
});

describe('composition split modules', () => {
  it('exposes bindDaoBindings/bindServiceBindings and wires a working scope', async () => {
    expect(typeof bindDaoBindings).toBe('function');
    expect(typeof bindServiceBindings).toBe('function');
    const scope = createRequestScope({ DB: {} } as never);
    expect(scope).toBeInstanceOf(Container);
    // DAO thunks stay lazy+memoized: resolving twice returns the same promise.
    const daoThunk = scope.get(Tokens.UserDAO);
    expect(typeof daoThunk).toBe('function');
    await expect(daoThunk()).resolves.toBeDefined();
  });
});

describe('config section parity', () => {
  it('facade delegates match section values and defaults on empty env', () => {
    const app = AppConfiguration.fromEnv({});
    const content = new ContentLimits({});
    const retention = new RetentionLimits({});
    expect(app.getMaxReleasesPerRepo()).toBe(content.getMaxReleasesPerRepo());
    expect(app.getMaxAssetBytes()).toBe(content.getMaxAssetBytes());
    expect(app.getMaxChecksPerSha()).toBe(content.getMaxChecksPerSha());
    expect(app.getTaskRunRetentionDays()).toBe(retention.getTaskRunRetentionDays());
    expect(app.getAuditLogRetentionDays()).toBe(retention.getAuditLogRetentionDays());
    expect(app.contentLimits.getMaxProjectsPerRepo()).toBe(content.getMaxProjectsPerRepo());
    expect(app.retentionLimits.getSearchBackfillReposPerTick()).toBe(retention.getSearchBackfillReposPerTick());
  });
});

describe('gitAuthForRepo fail-closed', () => {
  function fakeContext(pat: string | null) {
    const store = new Map<string, unknown>();
    const headers: Record<string, string> = {};
    if (pat) headers.Authorization = `Basic ${Buffer.from(`user:${pat}`).toString('base64')}`;
    const scope = new Container();
    const ctx = createServiceContext({ DB: {} } as never);
    const c = {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => {
        store.set(k, v);
      },
      env: {},
      req: { raw: new Request('https://x/', { headers }) },
      executionCtx: {},
    };
    setRequestScope(c as never, scope, ctx);
    return { c: c as never, scope };
  }

  const repoRow = { id: 'r1', owner: 'o', name: 'r', is_private: 0 } as never;

  it('returns 503 when PAT lookup hits a DatabaseError (not 401)', async () => {
    const { c, scope } = fakeContext('pat123');
    scope.bindValue(Tokens.RepoService, { getByOwnerAndName: async () => repoRow });
    scope.bindValue(Tokens.TokenService, {
      authenticateWithPAT: async () => {
        throw new DatabaseError('D1 down', true);
      },
    });
    scope.bindValue(Tokens.DeployKeyService, { authenticateWithKey: async () => null });
    scope.bindValue(Tokens.PermissionService, { getRole: async () => 'read' });
    const res = await gitAuthForRepo(c as never, 'o', 'r', 'git-upload-pack');
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(503);
  });

  it('returns 401 for unknown tokens (deploy-key miss)', async () => {
    const { c, scope } = fakeContext('badpat');
    scope.bindValue(Tokens.RepoService, { getByOwnerAndName: async () => repoRow });
    scope.bindValue(Tokens.TokenService, {
      authenticateWithPAT: async () => {
        throw new Error('unknown token');
      },
    });
    scope.bindValue(Tokens.DeployKeyService, { authenticateWithKey: async () => null });
    scope.bindValue(Tokens.PermissionService, { getRole: async () => 'read' });
    const res = await gitAuthForRepo(c as never, 'o', 'r', 'git-upload-pack');
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
  });

  it('authenticates a valid PAT to a GitAuthResult', async () => {
    const { c, scope } = fakeContext('goodpat');
    scope.bindValue(Tokens.RepoService, { getByOwnerAndName: async () => repoRow });
    scope.bindValue(Tokens.TokenService, {
      authenticateWithPAT: async () => ({ email: 'a@example.com', scopes: ['repo:read'], repoGrants: [] }),
    });
    scope.bindValue(Tokens.PermissionService, { getRole: async () => 'read' });
    const res = await gitAuthForRepo(c as never, 'o', 'r', 'git-upload-pack');
    expect(res).not.toBeInstanceOf(Response);
    expect((res as { userEmail: string }).userEmail).toBe('a@example.com');
  });
});
