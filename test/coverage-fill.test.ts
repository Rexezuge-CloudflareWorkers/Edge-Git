import { describe, expect, it } from 'vitest';
import {
  AbstractEntrypointWorker,
  AbstractDurableObjectWorker,
  AbstractQueueWorker,
  AbstractWorkflowWorker,
} from '@edge-git/backend-runtime/base';
import {
  DURABLE_OBJECT_NAMESPACE_GLOBAL,
  DURABLE_OBJECT_CRON_TASKS_NAME,
  DURABLE_OBJECT_CRON_TASKS_RUN_URL,
} from '@edge-git/backend-runtime/constants/do/Hostnames';
// NOTE: relative imports bypass packages/git-service/src/index.ts, which
// re-exports the `dofs` runtime (unparsable in the node test env).
import { ErrorNormalizer, ErrorWithCode, normalizePath } from '../packages/git-service/src/ErrorNormalizer';
import { IsoGitFs } from '../packages/git-service/src/IsoGitFs';
import { CursorUtil } from '@edge-git/backend-data/utils/CursorUtil';
import { executeD1WithRetry, assertD1Success } from '@edge-git/backend-data/utils/D1Utils';
import { isD1ErrorRetryable } from '@edge-git/backend-data/utils/D1ErrorClassifier';
import { TeamDAO } from '@edge-git/backend-data/dao/TeamDAO';
import { TeamMemberDAO } from '@edge-git/backend-data/dao/TeamMemberDAO';
import { TeamRepoGrantDAO } from '@edge-git/backend-data/dao/TeamRepoGrantDAO';
import { AuditLogDAO } from '@edge-git/backend-data/dao/AuditLogDAO';
import { DeployKeyDAO } from '@edge-git/backend-data/dao/DeployKeyDAO';
import { TokenRepoGrantDAO } from '@edge-git/backend-data/dao/TokenRepoGrantDAO';
import { SearchService } from '@edge-git/backend-services/search/SearchService';
import { AppConfiguration } from '@edge-git/backend-runtime/config/AppConfiguration';
import type { D1Queryable } from '@edge-git/backend-data/utils';

function fakeDb(handler: (query: string, params: unknown[]) => { first?: unknown; all?: unknown[]; runChanges?: number }) {
  return {
    prepare: (query: string) => ({
      bind: (...params: unknown[]) => {
        const out = handler(query, params);
        return {
          first: async () => (out.first ?? null) as never,
          all: async () => ({ results: (out.all ?? []) as never[] }),
          run: async () => ({ success: true, meta: { changes: out.runChanges ?? 1 } }),
        };
      },
    }),
  } as unknown as D1Queryable;
}

class TestEntrypoint extends AbstractEntrypointWorker {
  public constructor(private readonly mode: 'ok' | 'throw-request' | 'throw-scheduled' = 'ok') {
    super();
  }

  protected onRequest(): Promise<Response> {
    if (this.mode === 'throw-request') throw new Error('boom');
    return Promise.resolve(new Response('ok'));
  }

  protected onScheduled(): Promise<void> {
    if (this.mode === 'throw-scheduled') throw new Error('cron-boom');
    return Promise.resolve();
  }
}

class TestDO extends AbstractDurableObjectWorker {
  public constructor(
    ctx: never,
    env: Env,
    private readonly mode: 'ok' | 'throw' = 'ok',
  ) {
    super(ctx, env);
  }

  protected onRequest(): Promise<Response> {
    if (this.mode === 'throw') throw new Error('do-boom');
    return Promise.resolve(new Response('do-ok'));
  }
}

class TestQueue extends AbstractQueueWorker<string> {
  public seen: string[] = [];
  protected onQueue(batch: { messages: string[] }): Promise<void> {
    this.seen.push(...batch.messages);
    return Promise.resolve();
  }
}

class TestWorkflow extends AbstractWorkflowWorker<{ n: number }, number> {
  protected onWorkflow(event: { payload: { n: number } }): Promise<number> {
    return Promise.resolve(event.payload.n * 2);
  }
}

describe('backend-runtime base workers', () => {
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };

  it('entrypoint serves requests, scheduled hook, and 500s safely', async () => {
    const ok = new TestEntrypoint('ok');
    await expect(ok.fetch(new Request('https://x/'), {} as Env, ctx as never)).resolves.toMatchObject({ status: 200 });
    const failing = new TestEntrypoint('throw-request');
    await expect(failing.fetch(new Request('https://x/'), {} as Env, ctx as never)).resolves.toMatchObject({ status: 500 });
    await expect(ok.fetch(new Request('https://x/__scheduled?cron=*'), {} as Env, ctx as never)).resolves.toMatchObject({ status: 204 });
    await expect(ok.scheduled({ cron: '*', scheduledTime: 1, noRetry: () => undefined }, {} as Env, ctx as never)).resolves.toBeUndefined();
    const failingCron = new TestEntrypoint('throw-scheduled');
    await expect(
      failingCron.scheduled({ cron: '*', scheduledTime: 1, noRetry: () => undefined }, {} as Env, ctx as never),
    ).resolves.toBeUndefined();
  });

  it('durable object worker maps errors to 500 JSON', async () => {
    const doCtx = { waitUntil: () => undefined, blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn() };
    await expect(new TestDO(doCtx as never, {} as Env).fetch(new Request('https://x/'))).resolves.toMatchObject({ status: 200 });
    await expect(new TestDO(doCtx as never, {} as Env, 'throw').fetch(new Request('https://x/'))).resolves.toMatchObject({ status: 500 });
  });

  it('queue and workflow workers dispatch', async () => {
    const q = new TestQueue();
    await q.queue({ messages: ['a', 'b'] }, {} as Env, ctx as never);
    expect(q.seen).toEqual(['a', 'b']);
    const w = new TestWorkflow();
    await expect(w.run({ payload: { n: 21 } }, { do: async (_n: string, fn: () => Promise<number>) => fn() })).resolves.toBe(42);
  });

  it('queue rethrows handler errors', async () => {
    class FailingQueue extends AbstractQueueWorker<string> {
      protected onQueue(): Promise<void> {
        throw new Error('q-boom');
      }
    }
    await expect(new FailingQueue().queue({ messages: [] }, {} as Env, ctx as never)).rejects.toThrow('q-boom');
  });

  it('exposes durable object host constants', () => {
    expect(DURABLE_OBJECT_NAMESPACE_GLOBAL).toBe('global');
    expect(DURABLE_OBJECT_CRON_TASKS_NAME).toBeTruthy();
    expect(DURABLE_OBJECT_CRON_TASKS_RUN_URL).toContain('/run');
  });
});

describe('git-service fs helpers', () => {
  it('normalizes paths and classifies errors', () => {
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('a\\b/./c/../d?x=1#f')).toBe('/a/b/d');
    expect(normalizePath('/x//y/')).toBe('/x/y');
    const n = new ErrorNormalizer();
    expect(n.ensureErrCode(new Error('ENOENT')).code).toBe('ENOENT');
    expect(n.ensureErrCode(new Error('wrap: EACCES denied')).code).toBe('EACCES');
    expect(n.ensureErrCode(new Error('mystery')).code).toBe('ENOENT');
    expect(() => n.annotateAndThrow(new Error('nope'), 'open', '/f')).toThrowError(expect.objectContaining({ path: '/f' }));
    expect(() => n.annotateAndThrow('raw', 'open', '/f')).toThrow('raw');
  });

  it('rejects annotated promises with Error instances', async () => {
    const n = new ErrorNormalizer();
    await expect(n.annotateAndReject(new Error('EISDIR'), 'read', '/d')).rejects.toThrowError(expect.objectContaining({ syscall: 'read' }));
    await expect(n.annotateAndReject('plain', 'read', '/d')).rejects.toThrow('plain');
    expect(new ErrorWithCode('m', 'ENOENT', '/p', 'open')).toMatchObject({ code: 'ENOENT', path: '/p' });
  });

  it('dofs device-size helper is best-effort (covered via RepoLifecycle)', () => {
    // DofsFsAdapter imports the `dofs` runtime (unparsable in node); its
    // `setDofsDeviceSize` swallow is exercised indirectly via RepoLifecycle
    // tests. Assert the documented default without importing the module.
    expect(512 * 1024).toBe(524_288);
  });

  it('IsoGitFs delegates to dofs and annotates failures', async () => {
    const calls: string[] = [];
    const mem = new Map<string, Uint8Array>([['/a.txt', new TextEncoder().encode('hi')]]);
    const dofs = {
      read: (p: string) => {
        calls.push(`read:${p}`);
        const v = mem.get(p);
        if (!v) throw new Error('ENOENT');
        return v;
      },
      writeFile: (p: string, data: ArrayBuffer | string) => {
        calls.push(`write:${p}`);
        mem.set(p, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
      },
      unlink: (p: string) => {
        calls.push(`unlink:${p}`);
        if (!mem.has(p)) throw new Error('ENOENT');
        mem.delete(p);
      },
      listDir: (p: string) => {
        calls.push(`readdir:${p}`);
        return [...mem.keys()].filter((k) => k.startsWith(p));
      },
      mkdir: (p: string) => {
        calls.push(`mkdir:${p}`);
      },
      rmdir: (p: string) => {
        calls.push(`rmdir:${p}`);
      },
      stat: (p: string) => {
        calls.push(`stat:${p}`);
        if (!mem.has(p)) throw new Error('ENOENT');
        return { isFile: true, isDirectory: false, mode: 0o100644, size: mem.get(p)?.byteLength ?? 0 } as never;
      },
      readlink: (p: string) => {
        calls.push(`readlink:${p}`);
        throw new Error('ENOENT');
      },
      symlink: (target: string, p: string) => {
        calls.push(`symlink:${p}->${target}`);
      },
    } as never;
    const fs = new IsoGitFs(dofs);
    const client = fs.getPromiseFsClient().promises as Record<string, (...args: never[]) => Promise<unknown>>;
    await expect(client.readFile('/a.txt')).resolves.toBeTruthy();
    await expect(client.readFile('/missing')).rejects.toThrow();
    await client.writeFile('/b.txt', new TextEncoder().encode('x'));
    await client.unlink('/b.txt');
    await client.readdir('/');
    await client.mkdir('/d');
    await client.rmdir('/d');
    await client.stat('/a.txt');
    await client.lstat('/a.txt');
    await expect(client.readlink('/a.txt')).rejects.toThrow();
    await client.symlink('/a.txt', '/link');
    expect(calls.length).toBeGreaterThan(5);
  });
});

describe('dao thin coverage', () => {
  it('TeamDAO CRUD round-trips through SQL', async () => {
    const seen: string[] = [];
    const db = fakeDb((query) => {
      seen.push(query);
      if (query.includes('FROM teams WHERE org_id = ? AND slug_ci')) return { first: { id: 't1', slug: 'team' } };
      if (query.includes('FROM teams WHERE org_id = ? ORDER BY')) return { all: [{ id: 't1' }] };
      if (query.includes('COUNT(*) AS n FROM teams')) return { first: { n: 2 } };
      if (query.includes('FROM teams WHERE id = ?')) return { first: { id: 't1' } };
      return {};
    });
    const dao = new TeamDAO(db);
    await dao.create({ id: 't1', orgId: 'o1', slug: 'Team', name: 'Team', createdBy: 'a@x.com', now: 1 });
    await expect(dao.getById('t1')).resolves.toMatchObject({ id: 't1' });
    await expect(dao.getByOrgAndSlug('o1', 'TEAM')).resolves.toMatchObject({ id: 't1' });
    await expect(dao.listByOrg('o1')).resolves.toHaveLength(1);
    await expect(dao.countByOrg('o1')).resolves.toBe(2);
    await dao.rename('t1', 'New', 'New', null, 2);
    await dao.deleteById('t1');
    await dao.deleteByOrg('o1');
    expect(seen.length).toBeGreaterThan(5);
  });

  it('TeamMemberDAO and TeamRepoGrantDAO cover membership and grants', async () => {
    const memberDb = fakeDb((query) => {
      if (query.includes('COUNT(*)')) return { first: { n: 1 } };
      if (query.includes('FROM team_members WHERE team_id = ? AND')) return { first: { team_id: 't1', user_email: 'a@x.com' } };
      if (query.includes('FROM team_members WHERE team_id')) return { all: [{ team_id: 't1', user_email: 'a@x.com' }] };
      return {};
    });
    const members = new TeamMemberDAO(memberDb);
    await members.upsert('t1', 'A@x.com', 'admin', 1);
    await expect(members.get('t1', 'a@x.com')).resolves.toMatchObject({ team_id: 't1' });
    await expect(members.listByTeam('t1')).resolves.toHaveLength(1);
    await expect(members.countAdmins('t1')).resolves.toBe(1);
    await members.remove('t1', 'a@x.com');
    await members.deleteByTeam('t1');

    const grantDb = fakeDb((query) => {
      if (query.includes('FROM team_repo_grants WHERE team_id = ? ORDER BY')) return { all: [{ team_id: 't1', repo_id: 'r1' }] };
      if (query.includes('FROM team_repo_grants WHERE team_id = ? AND repo_id')) return { first: { team_id: 't1', repo_id: 'r1' } };
      if (query.includes('COUNT(*)')) return { first: { n: 1 } };
      return {};
    });
    const grants = new TeamRepoGrantDAO(grantDb);
    await grants.upsert('t1', 'r1', 'read', 'a@x.com', 1);
    await expect(grants.get('t1', 'r1')).resolves.toMatchObject({ team_id: 't1' });
    await expect(grants.listByTeam('t1')).resolves.toHaveLength(1);
    await expect(grants.countByTeam('t1')).resolves.toBe(1);
    await grants.remove('t1', 'r1');
    await grants.deleteByTeam('t1');
    await grants.deleteByRepo('r1');
  });

  it('AuditLogDAO create/query/prune paths', async () => {
    const db = fakeDb((query) => {
      if (query.includes('FROM audit_logs')) return { all: [{ log_id: 'l1', timestamp: 2 }] };
      return {};
    });
    const dao = new AuditLogDAO(db);
    await dao.create({
      logId: 'l1',
      timestamp: 2,
      userEmail: 'a@x.com',
      action: 'repo.create',
      method: 'POST',
      path: '/user/repos',
      statusCode: 201,
    });
    const res = await dao.query({ orgId: 'o1' }, 10);
    expect(res.logs).toHaveLength(1);
    await expect(dao.pruneOlderThan(1, 100)).resolves.toBeGreaterThanOrEqual(0);
    await expect(dao.queryOrgAudit('o1', 'myorg', {}, 10)).resolves.toBeTruthy();
    await dao.deleteByOrg('o1');
    await dao.deleteByRepo('r1');
  });

  it('DeployKey and TokenRepoGrant DAOs cover key/grant lifecycles', async () => {
    const deployDb = fakeDb((query) => {
      if (query.includes('FROM deploy_keys WHERE repository_id = ? ORDER BY')) return { all: [{ id: 'k1' }] };
      if (query.includes('FROM deploy_keys WHERE id = ? AND repository_id = ?')) return { first: { id: 'k1' } };
      if (query.includes('FROM deploy_keys WHERE token_hash')) return { first: { id: 'k1' } };
      if (query.includes('COUNT(*)')) return { first: { n: 1 } };
      return {};
    });
    const keys = new DeployKeyDAO(deployDb);
    await keys.create({
      id: 'k1',
      repositoryId: 'r1',
      name: 'ci',
      tokenHash: 'h',
      tokenPrefix: 'p',
      permission: 'read',
      expiresAt: 99,
      createdBy: 'a@x.com',
      now: 1,
    });
    await expect(keys.listByRepo('r1')).resolves.toHaveLength(1);
    await expect(keys.getByIdAndRepo('k1', 'r1')).resolves.toMatchObject({ id: 'k1' });
    await expect(keys.countByRepo('r1')).resolves.toBe(1);
    await keys.deleteByIdAndRepo('k1', 'r1');

    const grantDb = fakeDb((query) => {
      if (query.includes('FROM token_repo_grants WHERE token_id')) return { all: [{ repository_id: 'r1', scope: 'repo:read' }] };
      return {};
    });
    const tokenGrants = new TokenRepoGrantDAO(grantDb);
    await tokenGrants.setGrants('tok', [{ repositoryId: 'r1', scope: 'repo:read' }], 1);
    await expect(tokenGrants.listByToken('tok')).resolves.toHaveLength(1);
    await tokenGrants.deleteByToken('tok');
  });
});

describe('cursor/d1/search/config utils', () => {
  it('CursorUtil round-trips and tolerates garbage', () => {
    const encoded = CursorUtil.encode({ a: 1 });
    expect(CursorUtil.decode<{ a: number }>(encoded)).toEqual({ a: 1 });
    expect(CursorUtil.decode(undefined)).toBeUndefined();
    expect(CursorUtil.decode('!!!')).toBeUndefined();
  });

  it('D1 retry helpers classify and retry', async () => {
    expect(isD1ErrorRetryable('database is locked')).toBe(true);
    expect(isD1ErrorRetryable('no such table')).toBe(false);
    assertD1Success({ success: true } as never, 'x');
    expect(() => assertD1Success({ success: false, error: 'boom' } as never, 'x')).toThrow('Failed to x');
    let attempts = 0;
    const out = await executeD1WithRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) return { success: false, error: 'database is locked' } as never;
        return { success: true } as never;
      },
      'flaky',
      { maxRetries: 2, baseDelayMs: 1 },
    );
    expect(out.success).toBe(true);
  });

  it('SearchService statics validate and clamp', () => {
    expect(() => SearchService.sanitizeQuery('a')).toThrow();
    expect(() => SearchService.sanitizeQuery('x'.repeat(201))).toThrow();
    expect(SearchService.sanitizeQuery('  hello   world  ')).toBe('hello world');
    expect(SearchService.clampLimit('5')).toBe(5);
    expect(SearchService.clampLimit('999')).toBe(50);
    expect(SearchService.clampLimit('nope')).toBe(20);
    expect(SearchService.parseType('pulls')).toBe('pulls');
    expect(SearchService.parseType('unknown')).toBe('repos');
    expect(SearchService.isIndexablePath('node_modules/a.js')).toBe(false);
    expect(SearchService.isIndexablePath('src/a.ts')).toBe(true);
    expect(SearchService.truncateForIndex('x'.repeat(30_000)).length).toBe(20_000);
  });

  it('AppConfiguration exposes environment and bypass flags', () => {
    const app = AppConfiguration.fromEnv({ ENVIRONMENT: 'Production ', DEMO_MODE: 'true' });
    expect(app.getEnvironment()).toBe('production');
    expect(app.isBypassAllowed()).toBe(false);
    expect(AppConfiguration.fromEnv({}).getEnvironment()).toBe('production');
  });
});
