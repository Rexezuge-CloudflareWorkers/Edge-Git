import { describe, expect, it, vi } from 'vitest';
import { isMissingSchemaError } from '@edge-git/backend-data/utils';
import { RepositoryDAO } from '@edge-git/backend-data/dao';
import { SearchDAO } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { DatabaseError } from '@edge-git/backend-errors';
import { PermissionService } from '@edge-git/backend-services/permission';
import { createRequestScope } from '@edge-git/backend-services/composition';
import { Tokens } from '@edge-git/backend-services/composition';
import {
  interpretReturn,
  isInterruptMessage,
  isRecord,
  stripTrailingDots,
  toSandboxResult,
} from '@edge-git/background/checks/SandboxUtils';
import { runBuiltInStep } from '@edge-git/background/checks/CheckStepExecutor';
import { PushHandler } from '@edge-git/background/PushHandler';

function failingDb(message: string): D1Queryable {
  return {
    prepare: () => ({
      bind: () => ({
        first: () => Promise.reject(new Error(message)),
        all: () => Promise.reject(new Error(message)),
        run: () => Promise.reject(new Error(message)),
      }),
    }),
  } as unknown as D1Queryable;
}

function trackingDb(onQuery: (sql: string) => void): D1Queryable {
  return {
    prepare: (sql: string) => ({
      bind: (..._params: unknown[]) => {
        onQuery(sql);
        return {
          first: () => Promise.resolve(null),
          all: () => Promise.resolve({ results: [] }),
          run: () => Promise.resolve({ success: true, meta: { changes: 0 } }),
        };
      },
    }),
  } as unknown as D1Queryable;
}

describe('hardening batch: fail-closed data layer', () => {
  it('isMissingSchemaError distinguishes legacy schema from genuine failures', () => {
    expect(isMissingSchemaError(new Error('no such table: repositories'))).toBe(true);
    expect(isMissingSchemaError(new Error('no such column: owner_ci'))).toBe(true);
    expect(isMissingSchemaError(new Error('UNIQUE constraint failed'))).toBe(false);
    expect(isMissingSchemaError(new Error('database is locked'))).toBe(false);
    expect(isMissingSchemaError(new Error('Network error'))).toBe(false);
  });

  it('RepositoryDAO uses indexed owner_ci lookup first', async () => {
    const seen: string[] = [];
    const dao = new RepositoryDAO(trackingDb((sql) => seen.push(sql)));
    await dao.getByOwnerAndName('Alice', 'Repo');
    expect(seen[0]).toContain('owner_ci');
  });

  it('RepositoryDAO listByOrgId propagates errors instead of degrading (0021 baseline)', async () => {
    // Post-0021 the org columns are part of the baseline schema: no
    // missing-schema degrade branch remains — errors propagate raw.
    await expect(new RepositoryDAO(failingDb('connection timeout')).listByOrgId('org-1')).rejects.toThrow('connection timeout');
    await expect(new RepositoryDAO(failingDb('no such table: repositories')).listByOrgId('org-1')).rejects.toThrow('no such table');
  });

  it('RepositoryDAO listForks/countForks/listRecent fail closed', async () => {
    const bad = failingDb('disk I/O error');
    await expect(new RepositoryDAO(bad).listForks('r1')).rejects.toBeInstanceOf(DatabaseError);
    await expect(new RepositoryDAO(bad).countForks('r1')).rejects.toBeInstanceOf(DatabaseError);
    await expect(new RepositoryDAO(bad).listRecent()).rejects.toBeInstanceOf(DatabaseError);
    const legacy = failingDb('no such table: repositories');
    await expect(new RepositoryDAO(legacy).listForks('r1')).rejects.toBeInstanceOf(DatabaseError);
    await expect(new RepositoryDAO(legacy).countForks('r1')).rejects.toBeInstanceOf(DatabaseError);
  });

  it('RepositoryDAO create does not swallow constraint errors', async () => {
    const dao = new RepositoryDAO(failingDb('UNIQUE constraint failed: repositories.id'));
    await expect(
      dao.create({ id: 'x', ownerEmail: 'a@b.c', owner: 'a', name: 'r', description: null, isPrivate: false, now: 1 }),
    ).rejects.toThrow();
  });

  it('SearchDAO searchRepos throws on genuine errors', async () => {
    const dao = new SearchDAO(failingDb('connection reset'));
    await expect(dao.searchRepos('hello world')).rejects.toBeInstanceOf(DatabaseError);
  });

  it('PermissionService throws on genuine DB errors instead of public-read fallback', async () => {
    const boom = () => Promise.reject(new Error('connection timeout'));
    const svc = new PermissionService(
      { DB: {} as never },
      {
        organizationDAO: boom,
        organizationMemberDAO: boom,
        repoCollaboratorDAO: boom,
        namespaceDAO: boom,
        teamDAO: boom,
        teamMemberDAO: boom,
        teamGrantDAO: boom,
      },
    );
    const repo = { id: 'r1', owner: 'alice', owner_email: 'alice@x.y', name: 'r', is_private: 1 } as never;
    await expect(svc.getRole('bob@x.y', repo)).rejects.toBeInstanceOf(DatabaseError);
  });

  it('composition root wires typed tokens with a single PermissionService', async () => {
    const scope = createRequestScope({ DB: trackingDb(() => undefined) });
    expect(scope.has(Tokens.RepositoryDAO)).toBe(true);
    expect(scope.has(Tokens.PermissionService)).toBe(true);
    const a = scope.get(Tokens.PermissionService);
    const b = scope.get(Tokens.PermissionService);
    expect(a).toBe(b);
    const daoFactory = scope.get(Tokens.RepositoryDAO);
    const d1 = await daoFactory();
    const d2 = await daoFactory();
    expect(d1).toBe(d2);
  });
});

describe('hardening batch: sandbox + check steps', () => {
  it('toSandboxResult truncates title/summary and appends logs', () => {
    const r = toSandboxResult('success', 'T'.repeat(500), 'S', ['l1', 'l2']);
    expect(r.conclusion).toBe('success');
    expect(r.title.length).toBeLessThanOrEqual(200);
    expect(r.summary).toContain('l1');
  });

  it('interpretReturn rejects bad conclusions fail-closed', () => {
    expect(interpretReturn({ conclusion: 'bogus' }, []).conclusion).toBe('action_required');
    expect(interpretReturn(null, []).conclusion).toBe('action_required');
    expect(interpretReturn({ conclusion: 'success', title: '  Hi  ' }, []).title).toBe('Hi');
  });

  it('stripTrailingDots/isRecord/isInterruptMessage behave', () => {
    expect(stripTrailingDots('example.com...')).toBe('example.com');
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isInterruptMessage('interrupted by timer')).toBe(true);
    expect(isInterruptMessage('boom')).toBe(false);
  });

  it('runBuiltInStep unknown base is neutral, required-files defaults README', async () => {
    const stub = {
      listAllFiles: () => Promise.resolve([]),
      getBlob: () => Promise.resolve(null),
      getCommitDiff: () => Promise.resolve(null),
    };
    const unknown = await runBuiltInStep({}, stub, 'abc', 'mystery', '');
    expect(unknown.conclusion).toBe('neutral');
    const required = await runBuiltInStep({}, stub, 'abc', 'required-files', '');
    expect(required.title.length).toBeGreaterThan(0);
  });
});

describe('hardening batch: PushHandler ancestry + idx cleanup', () => {
  function makeHandler(opts: {
    ancestorThrows?: boolean;
    ancestor?: boolean;
    indexed?: { unlink: (p: string) => Promise<void>; unlinked: string[] };
  }) {
    const unlinked: string[] = [];
    const isoGitFs = {
      promises: {
        writeFile: () => Promise.resolve(undefined),
        unlink: (p: string) => {
          unlinked.push(p);
          return Promise.resolve(undefined);
        },
      },
    };
    const git = {
      indexPack: () => Promise.resolve(undefined),
      isAncestor: opts.ancestorThrows ? () => Promise.reject(new Error('transient D1')) : () => Promise.resolve(opts.ancestor ?? true),
      applyRefUpdates: () => Promise.resolve([{ ref: 'refs/heads/main', ok: true as const }]),
      clearCache: vi.fn(),
    };
    const handler = new PushHandler({ isoGitFs: isoGitFs as never, git: git as never, getFullName: () => 'a/r' });
    return { handler, unlinked, git };
  }

  it('transient isAncestor failure returns unpack-failed, not force-blocked', async () => {
    const { handler } = makeHandler({ ancestorThrows: true });
    const body = new Uint8Array([1, 2, 3]);
    vi.spyOn(await import('@edge-git/git-protocol'), 'parseReceivePackRequest').mockReturnValueOnce({
      commands: [{ ref: 'refs/heads/main', oldOid: 'a'.repeat(40), newOid: 'b'.repeat(40) }],
      packfile: body,
      capabilities: [],
    });
    const res = await handler.receivePack(body, { maxCommands: 10, maxPackBytes: 10_000 }, [
      { ref: 'refs/heads/main', blockForcePush: true } as never,
    ]);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('unpack failed');
  });

  it('blocked force-push unlinks both pack and idx', async () => {
    const { handler, unlinked } = makeHandler({ ancestor: false });
    const body = new Uint8Array([1, 2, 3]);
    vi.spyOn(await import('@edge-git/git-protocol'), 'parseReceivePackRequest').mockReturnValueOnce({
      commands: [{ ref: 'refs/heads/main', oldOid: 'a'.repeat(40), newOid: 'b'.repeat(40) }],
      packfile: body,
      capabilities: [],
    });
    await handler.receivePack(body, { maxCommands: 10, maxPackBytes: 10_000 }, [{ ref: 'refs/heads/main', blockForcePush: true } as never]);
    expect(unlinked.some((p) => p.endsWith('.pack'))).toBe(true);
    expect(unlinked.some((p) => p.endsWith('.idx'))).toBe(true);
  });
});
