import { describe, expect, it, vi } from 'vitest';

// `RepoReadRpc`/`RepoLifecycle` value-import from the git-service barrel
// (`PackLimitError`/`setDofsDeviceSize`), which pulls `dofs` →
// `cloudflare:*` (unavailable in the node unit pool). Stub the barrel the
// same way `repo-lifecycle.test.ts` / `fetch-handler-hardening.test.ts` do;
// every collaborator below is still an in-memory fake via constructor
// injection — the mock only preserves the `PackLimitError` shape.
vi.mock('@edge-git/git-service', () => {
  class PackLimitError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PackLimitError';
    }
  }
  return { PackLimitError, setDofsDeviceSize: vi.fn() };
});

import { RepoReadRpc } from '@edge-git/background/RepoReadRpc';
import { RepoLifecycle } from '@edge-git/background/RepoLifecycle';
import { ReleaseAssetStore } from '@edge-git/background/ReleaseAssetStore';
import { RepoWorker } from '@edge-git/background/RepoWorker';
import { moveOneRepo, moveRepoDosForRename } from '@/workers/routes/RepoMove';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const OID_ZERO = '0'.repeat(40);

type Fn = ReturnType<typeof vi.fn>;

function makeGit(overrides: Record<string, Fn> = {}): Record<string, Fn> {
  const base: Record<string, Fn> = {
    listRefs: vi.fn(async () => ({ refs: [], symbolicHead: null })),
    resolveRef: vi.fn(async () => OID_A),
    createBranch: vi.fn(async () => ({ ok: true })),
    deleteBranchRef: vi.fn(async () => ({ ok: true })),
    commitFile: vi.fn(async () => ({ ok: true, oid: OID_A })),
    setDefaultBranch: vi.fn(async () => ({ ok: true })),
    clearCache: vi.fn(() => undefined),
    ensureFreshCache: vi.fn(() => undefined),
    hasObject: vi.fn(async () => true),
    isAncestor: vi.fn(async () => true),
    applyRefUpdates: vi.fn(async (updates: Array<{ ref: string; oldOid: string; newOid: string }>) =>
      updates.map(() => ({ ok: true })),
    ),
    collectObjectsForPack: vi.fn(async () => ({ oids: [OID_A] })),
    packObjects: vi.fn(async () => new Uint8Array([1, 2, 3])),
    indexPack: vi.fn(async () => undefined),
    mergeBranches: vi.fn(async () => ({ type: 'merged', oid: OID_A })),
    squashMerge: vi.fn(async () => ({ type: 'squashed', oid: OID_A })),
    rebaseMerge: vi.fn(async () => ({ type: 'rebased', oid: OID_A })),
    deleteBranch: vi.fn(async () => undefined),
  };
  return { ...base, ...overrides };
}

function makeReadModel(overrides: Record<string, Fn> = {}): Record<string, Fn> {
  const base: Record<string, Fn> = {
    getLatestCommit: vi.fn(async () => ({ oid: OID_A })),
    getCommits: vi.fn(async () => []),
    getBranches: vi.fn(async () => ({ branches: ['main'], currentBranch: 'main' })),
    getTags: vi.fn(async () => []),
    getTree: vi.fn(async () => []),
    getBlob: vi.fn(async () => null),
    getOverview: vi.fn(async () => ({ branches: [] })),
    listAllFiles: vi.fn(async () => []),
    getCommit: vi.fn(async () => null),
    getCommitDiff: vi.fn(async () => ({ files: [] })),
    getCompare: vi.fn(async () => ({ files: [] })),
    getMergePreview: vi.fn(async () => null),
    getMergePreviewByOids: vi.fn(async () => null),
    getPullDiff: vi.fn(async () => ({ changes: [] })),
    getBlame: vi.fn(async () => []),
  };
  return { ...base, ...overrides };
}

function makeFs(): { promises: { writeFile: Fn; unlink: Fn } } {
  return {
    promises: {
      writeFile: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
    },
  };
}

function makeAssetStore() {
  return {
    store: vi.fn(async () => ({ ok: true, size: 3 })),
    load: vi.fn(async () => new Uint8Array([1, 2, 3])),
    remove: vi.fn(async () => ({ deleted: true })),
    removeAll: vi.fn(async () => ({ deleted: 2 })),
  };
}

function makeRpc(parts: {
  gitOverrides?: Record<string, Fn>;
  readModelOverrides?: Record<string, Fn>;
  withFs?: boolean;
  withAssets?: boolean;
  limits?: { maxObjects: number; maxPackBytes: number; maxRefs?: number };
} = {}) {
  const prepare = vi.fn(async () => undefined);
  const git = makeGit(parts.gitOverrides);
  const readModel = makeReadModel(parts.readModelOverrides);
  const isoGitFs = parts.withFs === false ? undefined : makeFs();
  const releaseAssets = parts.withAssets === false ? undefined : makeAssetStore();
  const config = { getMaxMergeDiffFiles: () => 7, getMaxFileBytes: () => 1024 };
  const getLimits = parts.limits ? () => parts.limits as { maxObjects: number; maxPackBytes: number; maxRefs?: number } : undefined;
  const rpc = new RepoReadRpc({ git, readModel, prepare, config, isoGitFs, releaseAssets, getLimits } as never);
  return { rpc, git, readModel, prepare, isoGitFs, releaseAssets };
}

describe('RepoReadRpc prepare gate + read fan-out', () => {
  it('runs prepare() before git I/O on listRefs', async () => {
    const { rpc, git, prepare } = makeRpc();
    await rpc.listRefs();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(git.listRefs).toHaveBeenCalledTimes(1);
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(git.listRefs.mock.invocationCallOrder[0]);
  });

  it('gates every read-model passthrough behind prepare()', async () => {
    const { rpc, readModel, prepare } = makeRpc();
    await rpc.getBranches();
    await rpc.getTree({ ref: 'main' });
    await rpc.getBlob({ ref: 'main', filepath: 'a.txt' });
    await rpc.getCommits({ ref: 'main' });
    await rpc.getTags();
    expect(prepare).toHaveBeenCalledTimes(5);
    expect(readModel.getBranches).toHaveBeenCalledTimes(1);
    expect(readModel.getTree).toHaveBeenCalledTimes(1);
    expect(readModel.getBlob).toHaveBeenCalledTimes(1);
    expect(readModel.getCommits).toHaveBeenCalledTimes(1);
    expect(readModel.getTags).toHaveBeenCalledTimes(1);
  });

  it('listRefs passes the git payload through', async () => {
    const payload = { refs: [{ ref: 'refs/heads/main', oid: OID_A }], symbolicHead: 'refs/heads/main' };
    const { rpc } = makeRpc({ gitOverrides: { listRefs: vi.fn(async () => payload) } });
    await expect(rpc.listRefs()).resolves.toEqual(payload);
  });

  it('getBranches passes the read-model payload through', async () => {
    const { rpc } = makeRpc();
    await expect(rpc.getBranches()).resolves.toEqual({ branches: ['main'], currentBranch: 'main' });
  });

  it('getTree forwards its args', async () => {
    const { rpc, readModel } = makeRpc();
    const args = { ref: 'main', path: 'src', withLastCommit: false };
    await rpc.getTree(args);
    expect(readModel.getTree).toHaveBeenCalledWith(args);
  });

  it('getBlob forwards its args', async () => {
    const { rpc, readModel } = makeRpc();
    const args = { ref: 'main', filepath: 'README.md' };
    await rpc.getBlob(args);
    expect(readModel.getBlob).toHaveBeenCalledWith(args);
  });

  it('getCommits forwards its args', async () => {
    const { rpc, readModel } = makeRpc();
    const args = { ref: 'main', depth: 5, filepath: 'a.txt' };
    await rpc.getCommits(args);
    expect(readModel.getCommits).toHaveBeenCalledWith(args);
  });

  it('getLatestCommit defaults to HEAD', async () => {
    const { rpc, readModel } = makeRpc();
    await rpc.getLatestCommit();
    expect(readModel.getLatestCommit).toHaveBeenCalledWith('HEAD');
    await rpc.getLatestCommit('main');
    expect(readModel.getLatestCommit).toHaveBeenCalledWith('main');
  });

  it('getTags passes the read-model payload through', async () => {
    const tags = [{ name: 'v1', ref: 'refs/tags/v1', oid: OID_A, peeledOid: null, type: 'lightweight' }];
    const { rpc } = makeRpc({ readModelOverrides: { getTags: vi.fn(async () => tags) } });
    await expect(rpc.getTags()).resolves.toEqual(tags);
  });

  it('getOverview forwards its args', async () => {
    const { rpc, readModel } = makeRpc();
    const args = { ref: 'main', depth: 3, includeTags: true, includeReadme: false };
    await rpc.getOverview(args);
    expect(readModel.getOverview).toHaveBeenCalledWith(args);
  });

  it('listAllFiles forwards its args', async () => {
    const { rpc, readModel } = makeRpc();
    const args = { ref: 'main', maxFiles: 50 };
    await rpc.listAllFiles(args);
    expect(readModel.listAllFiles).toHaveBeenCalledWith(args);
  });

  it('getCommit forwards the oid', async () => {
    const { rpc, readModel } = makeRpc();
    await rpc.getCommit(OID_A);
    expect(readModel.getCommit).toHaveBeenCalledWith(OID_A);
  });

  it('getCommitDiff injects the configured merge-diff file cap', async () => {
    const { rpc, readModel } = makeRpc();
    await rpc.getCommitDiff(OID_A);
    expect(readModel.getCommitDiff).toHaveBeenCalledWith(OID_A, 7);
  });

  it('getCompare injects the configured merge-diff file cap', async () => {
    const { rpc, readModel } = makeRpc();
    await rpc.getCompare({ baseRef: 'main', headRef: 'feat' });
    expect(readModel.getCompare).toHaveBeenCalledWith('main', 'feat', 7);
  });

  it('merge previews forward refs and oids', async () => {
    const { rpc, readModel } = makeRpc();
    await rpc.getMergePreview({ baseRef: 'main', headRef: 'feat' });
    await rpc.getMergePreviewByOids({ baseOid: OID_A, headOid: OID_B });
    expect(readModel.getMergePreview).toHaveBeenCalledWith('main', 'feat');
    expect(readModel.getMergePreviewByOids).toHaveBeenCalledWith(OID_A, OID_B);
  });

  it('getPullDiff forwards a null base plus the file cap', async () => {
    const { rpc, readModel } = makeRpc();
    await rpc.getPullDiff({ baseOid: null, headOid: OID_A });
    expect(readModel.getPullDiff).toHaveBeenCalledWith(null, OID_A, 7);
  });

  it('resolveRef and hasObject pass through git', async () => {
    const { rpc, git } = makeRpc();
    await rpc.resolveRef('refs/heads/main');
    await rpc.hasObject(OID_A);
    expect(git.resolveRef).toHaveBeenCalledWith('refs/heads/main');
    expect(git.hasObject).toHaveBeenCalledWith(OID_A);
  });
});

describe('RepoReadRpc branch management', () => {
  it('createBranch maps unknown start points to 404 without git writes', async () => {
    const { rpc, git, prepare } = makeRpc({ gitOverrides: { resolveRef: vi.fn(async () => null) } });
    await expect(rpc.createBranch({ name: 'feat' })).resolves.toEqual({
      ok: false,
      error: 'unknown start point',
      status: 404,
    });
    expect(git.createBranch).not.toHaveBeenCalled();
    expect(git.clearCache).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('createBranch defaults to HEAD and clears the cache on success', async () => {
    const { rpc, git } = makeRpc();
    await rpc.createBranch({ name: 'feat' });
    expect(git.resolveRef).toHaveBeenCalledWith('HEAD');
    expect(git.createBranch).toHaveBeenCalledWith('feat', OID_A);
    expect(git.clearCache).toHaveBeenCalledTimes(1);
  });

  it('createBranch failure results skip the cache clear', async () => {
    const { rpc, git } = makeRpc({ gitOverrides: { createBranch: vi.fn(async () => ({ ok: false, error: 'bad name', status: 400 })) } });
    await rpc.createBranch({ name: 'bad name', fromRef: 'main' });
    expect(git.resolveRef).toHaveBeenCalledWith('main');
    expect(git.clearCache).not.toHaveBeenCalled();
  });

  it('deleteBranchRef clears the cache only on success', async () => {
    const ok = makeRpc();
    await ok.rpc.deleteBranchRef('feat');
    expect(ok.git.deleteBranchRef).toHaveBeenCalledWith('feat');
    expect(ok.git.clearCache).toHaveBeenCalledTimes(1);

    const bad = makeRpc({ gitOverrides: { deleteBranchRef: vi.fn(async () => ({ ok: false, error: 'nope', status: 404 })) } });
    await bad.rpc.deleteBranchRef('missing');
    expect(bad.git.clearCache).not.toHaveBeenCalled();
  });
});

describe('RepoReadRpc commit + default branch', () => {
  it('commitFile maps author/maxFileBytes and clears the cache on success', async () => {
    const { rpc, git } = makeRpc();
    await rpc.commitFile({
      branch: 'main',
      path: 'a.txt',
      content: new Uint8Array([1]),
      message: 'hi',
      expectedOid: OID_A,
      authorName: 'Al',
      authorEmail: 'al@example.com',
    });
    expect(git.commitFile).toHaveBeenCalledWith({
      branch: 'main',
      path: 'a.txt',
      content: new Uint8Array([1]),
      message: 'hi',
      expectedOid: OID_A,
      author: { name: 'Al', email: 'al@example.com' },
      maxFileBytes: 1024,
    });
    expect(git.clearCache).toHaveBeenCalledTimes(1);
  });

  it('setDefaultBranch clears the cache only on success', async () => {
    const ok = makeRpc();
    await ok.rpc.setDefaultBranch('main');
    expect(ok.git.setDefaultBranch).toHaveBeenCalledWith('main');
    expect(ok.git.clearCache).toHaveBeenCalledTimes(1);

    const bad = makeRpc({ gitOverrides: { setDefaultBranch: vi.fn(async () => ({ ok: false, error: 'nope' })) } });
    await bad.rpc.setDefaultBranch('missing');
    expect(bad.git.clearCache).not.toHaveBeenCalled();
  });
});

describe('RepoReadRpc isAncestor guard', () => {
  it('rejects malformed OIDs without touching git', async () => {
    const { rpc, git } = makeRpc();
    await expect(rpc.isAncestor('xyz', OID_A)).resolves.toBe(false);
    await expect(rpc.isAncestor(OID_A, 'short')).resolves.toBe(false);
    await expect(rpc.isAncestor(OID_A.toUpperCase(), OID_A)).resolves.toBe(false);
    expect(git.isAncestor).not.toHaveBeenCalled();
  });

  it('passes valid OIDs through and masks git failures as false', async () => {
    const ok = makeRpc();
    await expect(ok.rpc.isAncestor(OID_A, OID_B)).resolves.toBe(true);
    expect(ok.git.isAncestor).toHaveBeenCalledWith(OID_A, OID_B);

    const failing = makeRpc({ gitOverrides: { isAncestor: vi.fn(async () => { throw new Error('boom'); }) } });
    await expect(failing.rpc.isAncestor(OID_A, OID_B)).resolves.toBe(false);
  });
});

describe('RepoReadRpc updateRefs filtering', () => {
  it('short-circuits empty update lists without git I/O', async () => {
    const { rpc, git, prepare } = makeRpc();
    await expect(rpc.updateRefs([])).resolves.toEqual({ updated: [] });
    expect(git.applyRefUpdates).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it('drops malformed OIDs and non-branch/tag namespaces', async () => {
    const { rpc, git } = makeRpc();
    const result = await rpc.updateRefs([
      { ref: 'refs/heads/main', oldOid: OID_A, newOid: OID_B },
      { ref: 'refs/heads/bad', oldOid: 'not-an-oid', newOid: OID_B },
      { ref: 'refs/heads/bad2', oldOid: OID_A, newOid: 'short' },
      { ref: 'main', oldOid: OID_A, newOid: OID_B },
      { ref: 'refs/notes/x', oldOid: OID_A, newOid: OID_B },
    ]);
    expect(git.applyRefUpdates).toHaveBeenCalledTimes(1);
    expect(git.applyRefUpdates).toHaveBeenCalledWith(
      [{ oldOid: OID_A, newOid: OID_B, ref: 'refs/heads/main' }],
      false,
    );
    expect(result).toEqual({ updated: ['refs/heads/main'] });
    expect(git.clearCache).toHaveBeenCalledTimes(1);
  });

  it('reports only successfully applied refs', async () => {
    const { rpc } = makeRpc({
      gitOverrides: { applyRefUpdates: vi.fn(async () => [{ ok: true }, { ok: false, error: 'locked' }]) },
    });
    const result = await rpc.updateRefs([
      { ref: 'refs/heads/a', oldOid: OID_A, newOid: OID_B },
      { ref: 'refs/tags/v1', oldOid: OID_ZERO, newOid: OID_B },
    ]);
    expect(result).toEqual({ updated: ['refs/heads/a'] });
  });

  it('forwards large batches within maxRefs whole (no silent truncation)', async () => {
    const { rpc, git } = makeRpc({ limits: { maxObjects: 10_000, maxPackBytes: 52_428_800, maxRefs: 2000 } });
    const updates = Array.from({ length: 1500 }, (_, i) => ({
      ref: `refs/heads/b-${i}`,
      oldOid: OID_ZERO,
      newOid: OID_B,
    }));
    const result = (await rpc.updateRefs(updates)) as { updated: string[] };
    expect(git.applyRefUpdates).toHaveBeenCalledTimes(1);
    expect((git.applyRefUpdates.mock.calls[0][0] as unknown[])).toHaveLength(1500);
    expect(result.updated).toHaveLength(1500);
  });

  it('rejects batches over maxRefs', async () => {
    const { rpc, git } = makeRpc({ limits: { maxObjects: 10_000, maxPackBytes: 52_428_800, maxRefs: 10 } });
    const updates = Array.from({ length: 11 }, (_, i) => ({
      ref: `refs/heads/b-${i}`,
      oldOid: OID_ZERO,
      newOid: OID_B,
    }));
    await expect(rpc.updateRefs(updates)).rejects.toMatchObject({ name: 'PackLimitError' });
    expect(git.applyRefUpdates).not.toHaveBeenCalled();
  });

  it('blocks deletions and tag overwrites via direct RPC', async () => {
    const { rpc, git } = makeRpc();
    // Deletion (new zero) is dropped.
    await expect(
      rpc.updateRefs([{ ref: 'refs/heads/main', oldOid: OID_A, newOid: OID_ZERO }]),
    ).resolves.toEqual({ updated: [] });
    // Tag overwrite (existing tag) is dropped; tag create (old zero) passes.
    await expect(
      rpc.updateRefs([{ ref: 'refs/tags/v1', oldOid: OID_A, newOid: OID_B }]),
    ).resolves.toEqual({ updated: [] });
    expect(git.applyRefUpdates).not.toHaveBeenCalled();
  });

  it('returns empty when every update is malformed', async () => {
    const { rpc, git } = makeRpc();
    await expect(rpc.updateRefs([{ ref: 'refs/heads/x', oldOid: 'bad', newOid: 'worse' }])).resolves.toEqual({
      updated: [],
    });
    expect(git.applyRefUpdates).not.toHaveBeenCalled();
  });
});

describe('RepoReadRpc exportPack bounds', () => {
  it('short-circuits empty wants without git I/O', async () => {
    const { rpc, git } = makeRpc({ limits: { maxObjects: 10, maxPackBytes: 100 } });
    await expect(rpc.exportPack([])).resolves.toEqual({ oids: [], pack: null });
    expect(git.collectObjectsForPack).not.toHaveBeenCalled();
  });

  it('returns null pack when nothing was collected', async () => {
    const { rpc, git } = makeRpc({
      limits: { maxObjects: 10, maxPackBytes: 100 },
      gitOverrides: { collectObjectsForPack: vi.fn(async () => ({ oids: [] })) },
    });
    await expect(rpc.exportPack([OID_A])).resolves.toEqual({ oids: [], pack: null });
    expect(git.packObjects).not.toHaveBeenCalled();
  });

  it('rejects packs over maxPackBytes', async () => {
    const { rpc } = makeRpc({
      limits: { maxObjects: 10, maxPackBytes: 4 },
      gitOverrides: { packObjects: vi.fn(async () => new Uint8Array([1, 2, 3, 4, 5])) },
    });
    await expect(rpc.exportPack([OID_A])).rejects.toMatchObject({ name: 'PackLimitError' });
    await expect(rpc.exportPack([OID_A])).rejects.toThrow(/pack too large/);
  });

  it('maps zero-byte packs to null and falls back to default limits', async () => {
    const empty = makeRpc({ gitOverrides: { packObjects: vi.fn(async () => new Uint8Array(0)) } });
    await expect(empty.rpc.exportPack([OID_A])).resolves.toEqual({ oids: [OID_A], pack: null });
    expect(empty.git.collectObjectsForPack).toHaveBeenCalledWith([OID_A], [], { maxObjects: 10_000 });

    const pack = new Uint8Array([9, 9]);
    const ok = makeRpc({ gitOverrides: { packObjects: vi.fn(async () => pack) } });
    await expect(ok.rpc.exportPack([OID_A])).resolves.toEqual({ oids: [OID_A], pack });
  });
});

describe('RepoReadRpc importPack limits', () => {
  it('short-circuits empty packs without fs writes', async () => {
    const { rpc, isoGitFs } = makeRpc({ limits: { maxObjects: 10, maxPackBytes: 100 } });
    await expect(rpc.importPack(new Uint8Array(0))).resolves.toEqual({ importedRefs: [] });
    expect(isoGitFs?.promises.writeFile).not.toHaveBeenCalled();
  });

  it('rejects packs over maxPackBytes before any fs write', async () => {
    const { rpc, isoGitFs } = makeRpc({ limits: { maxObjects: 10, maxPackBytes: 4 } });
    await expect(rpc.importPack(new Uint8Array([1, 2, 3, 4, 5]))).rejects.toMatchObject({ name: 'PackLimitError' });
    expect(isoGitFs?.promises.writeFile).not.toHaveBeenCalled();
  });

  it('returns empty when no isoGitFs client is injected', async () => {
    const { rpc, git } = makeRpc({ withFs: false, limits: { maxObjects: 10, maxPackBytes: 100 } });
    await expect(rpc.importPack(new Uint8Array([1, 2]))).resolves.toEqual({ importedRefs: [] });
    expect(git.indexPack).not.toHaveBeenCalled();
    expect(git.applyRefUpdates).not.toHaveBeenCalled();
  });

  it('writes a fork pack, indexes the repo-relative path, and filters bad ref OIDs', async () => {
    const { rpc, git, isoGitFs } = makeRpc({ limits: { maxObjects: 100, maxPackBytes: 1024 } });
    const pack = new Uint8Array([7, 8, 9]);
    const result = await rpc.importPack(pack, [
      { ref: 'refs/heads/main', oid: OID_A },
      { ref: 'refs/heads/bad', oid: 'not-hex' },
    ]);
    expect(result).toEqual({ importedRefs: ['refs/heads/main'] });
    const writtenPath = isoGitFs?.promises.writeFile.mock.calls[0][0] as string;
    expect(writtenPath.startsWith('/repo/objects/pack/fork-')).toBe(true);
    expect(isoGitFs?.promises.writeFile.mock.calls[0][1]).toBe(pack);
    const indexedPath = git.indexPack.mock.calls[0][0] as string;
    expect(indexedPath.startsWith('objects/pack/fork-')).toBe(true);
    expect(indexedPath.startsWith('/repo')).toBe(false);
    expect(git.applyRefUpdates).toHaveBeenCalledWith(
      [{ oldOid: OID_ZERO, newOid: OID_A, ref: 'refs/heads/main' }],
      false,
    );
    expect(git.clearCache).toHaveBeenCalled();
  });

  it('removes the partial pack when indexing fails and rethrows', async () => {
    const boom = new Error('index failed');
    const { rpc, git, isoGitFs } = makeRpc({
      limits: { maxObjects: 100, maxPackBytes: 1024 },
      gitOverrides: {
        indexPack: vi.fn(async () => {
          throw boom;
        }),
      },
    });
    await expect(rpc.importPack(new Uint8Array([1]))).rejects.toBe(boom);
    const writtenPath = isoGitFs?.promises.writeFile.mock.calls[0][0];
    expect(isoGitFs?.promises.unlink).toHaveBeenCalledWith(writtenPath);
    expect(git.applyRefUpdates).not.toHaveBeenCalled();
  });
});

describe('RepoReadRpc mergePull routing', () => {
  function mergeArgs(overrides: Record<string, unknown> = {}) {
    return {
      baseBranch: 'main',
      headBranch: 'feat',
      headOid: OID_B,
      authorName: 'Al',
      authorEmail: 'al@example.com',
      ...overrides,
    };
  }

  it('routes squash strategy to squashMerge and clears the cache', async () => {
    const { rpc, git } = makeRpc();
    const result = (await rpc.mergePull(mergeArgs({ strategy: 'squash', message: 'sq' }))) as Record<string, unknown>;
    expect(git.squashMerge).toHaveBeenCalledWith({
      baseBranch: 'main',
      headOid: OID_B,
      author: { name: 'Al', email: 'al@example.com' },
      message: 'sq',
    });
    expect(git.mergeBranches).not.toHaveBeenCalled();
    expect(git.clearCache).toHaveBeenCalled();
    expect(result.deletedHead).toBe(false);
  });

  it('routes rebase strategy to rebaseMerge', async () => {
    const { rpc, git } = makeRpc();
    await rpc.mergePull(mergeArgs({ strategy: 'rebase' }));
    expect(git.rebaseMerge).toHaveBeenCalledWith({
      baseBranch: 'main',
      headOid: OID_B,
      author: { name: 'Al', email: 'al@example.com' },
    });
  });

  it('leaves the cache alone on conflicts and skips head deletion', async () => {
    const { rpc, git } = makeRpc({
      gitOverrides: { mergeBranches: vi.fn(async () => ({ type: 'conflict', files: [] })) },
    });
    const result = (await rpc.mergePull(mergeArgs({ deleteHead: true }))) as Record<string, unknown>;
    expect(result.type).toBe('conflict');
    expect(result.deletedHead).toBe(false);
    expect(git.clearCache).not.toHaveBeenCalled();
    expect(git.deleteBranch).not.toHaveBeenCalled();
  });

  it('deletes the head branch on successful merges unless it equals the base', async () => {
    const { rpc, git } = makeRpc();
    const result = (await rpc.mergePull(mergeArgs({ deleteHead: true }))) as Record<string, unknown>;
    expect(git.deleteBranch).toHaveBeenCalledWith('feat');
    expect(result.deletedHead).toBe(true);

    const same = makeRpc();
    const sameResult = (await same.rpc.mergePull(
      mergeArgs({ headBranch: 'main', deleteHead: true }),
    )) as Record<string, unknown>;
    expect(same.git.deleteBranch).not.toHaveBeenCalled();
    expect(sameResult.deletedHead).toBe(false);
  });
});

describe('RepoReadRpc deleteBranch', () => {
  it('returns deleted true on success and false when git throws', async () => {
    const { rpc, git } = makeRpc();
    await expect(rpc.deleteBranch('feat')).resolves.toEqual({ deleted: true });
    expect(git.deleteBranch).toHaveBeenCalledWith('feat');
    expect(git.clearCache).toHaveBeenCalledTimes(1);

    const failing = makeRpc({
      gitOverrides: {
        deleteBranch: vi.fn(async () => {
          throw new Error('locked');
        }),
      },
    });
    await expect(failing.rpc.deleteBranch('feat')).resolves.toEqual({ deleted: false });
  });
});

describe('RepoReadRpc getBlame path guard', () => {
  it('rejects empty and over-long paths without read-model I/O', async () => {
    const { rpc, readModel, prepare } = makeRpc();
    await expect(rpc.getBlame({ ref: 'main', filepath: '' })).resolves.toBeNull();
    await expect(rpc.getBlame({ ref: 'main', filepath: 'x'.repeat(501) })).resolves.toBeNull();
    expect(readModel.getBlame).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('delegates valid paths with a HEAD default', async () => {
    const { rpc, readModel } = makeRpc();
    await rpc.getBlame({ filepath: 'a.txt' });
    expect(readModel.getBlame).toHaveBeenCalledWith('HEAD', 'a.txt');
    await rpc.getBlame({ ref: 'main', filepath: 'a.txt' });
    expect(readModel.getBlame).toHaveBeenCalledWith('main', 'a.txt');
  });
});

describe('RepoReadRpc release assets', () => {
  it('degrades cleanly when the asset store is not configured', async () => {
    const { rpc, prepare } = makeRpc({ withAssets: false });
    await expect(
      rpc.storeReleaseAsset({ releaseId: 'r1', assetId: 'a1', bytes: new Uint8Array([1]) }),
    ).rejects.toThrow('Release assets are not configured');
    await expect(rpc.getReleaseAsset({ releaseId: 'r1', assetId: 'a1' })).resolves.toBeNull();
    await expect(rpc.deleteReleaseAsset({ releaseId: 'r1', assetId: 'a1' })).resolves.toEqual({ deleted: false });
    await expect(rpc.deleteReleaseAssets({ releaseId: 'r1' })).resolves.toEqual({ deleted: 0 });
    expect(prepare).toHaveBeenCalledTimes(4);
  });

  it('delegates to the configured store', async () => {
    const { rpc, releaseAssets } = makeRpc();
    const bytes = new Uint8Array([1, 2, 3]);
    await rpc.storeReleaseAsset({ releaseId: 'r1', assetId: 'a1', bytes });
    await rpc.getReleaseAsset({ releaseId: 'r1', assetId: 'a1' });
    await rpc.deleteReleaseAsset({ releaseId: 'r1', assetId: 'a1' });
    await rpc.deleteReleaseAssets({ releaseId: 'r1' });
    expect(releaseAssets?.store).toHaveBeenCalledWith({ releaseId: 'r1', assetId: 'a1', bytes });
    expect(releaseAssets?.load).toHaveBeenCalledWith({ releaseId: 'r1', assetId: 'a1' });
    expect(releaseAssets?.remove).toHaveBeenCalledWith({ releaseId: 'r1', assetId: 'a1' });
    expect(releaseAssets?.removeAll).toHaveBeenCalledWith({ releaseId: 'r1' });
  });
});

describe('ReleaseAssetStore traversal + caps + masking', () => {
  function makeMemFs(files = new Map<string, Uint8Array>()) {
    return {
      promises: {
        mkdir: vi.fn(async () => undefined),
        writeFile: vi.fn(async (path: string, bytes: Uint8Array) => {
          files.set(path, bytes);
        }),
        readFile: vi.fn(async (path: string) => {
          const value = files.get(path);
          if (!value) throw new Error('ENOENT');
          return value;
        }),
        unlink: vi.fn(async (path: string) => {
          if (!files.has(path)) throw new Error('ENOENT');
          files.delete(path);
        }),
        readdir: vi.fn(async (path: string) => {
          const prefix = `${path}/`;
          const names = [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
          if (names.length === 0) throw new Error('ENOENT');
          return names;
        }),
        rmdir: vi.fn(async () => undefined),
      },
    } as never;
  }

  it('rejects traversal ids on every entrypoint', async () => {
    const store = new ReleaseAssetStore(makeMemFs(), {} as Env);
    await expect(store.store({ releaseId: '../evil', assetId: 'a', bytes: new Uint8Array([1]) })).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    await expect(store.store({ releaseId: 'r1', assetId: '../../etc/passwd', bytes: new Uint8Array([1]) })).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    await expect(store.load({ releaseId: '../evil', assetId: 'a' })).resolves.toBeNull();
    await expect(store.remove({ releaseId: 'r1', assetId: 'a/b' })).resolves.toEqual({ deleted: false });
    await expect(store.removeAll({ releaseId: '..' })).resolves.toEqual({ deleted: 0 });
  });

  it('enforces non-empty payloads within the configured byte cap', async () => {
    const store = new ReleaseAssetStore(makeMemFs(), { MAX_ASSET_BYTES: '16' } as unknown as Env);
    await expect(store.store({ releaseId: 'r1', assetId: 'a1', bytes: new Uint8Array(0) })).resolves.toMatchObject({
      ok: false,
      status: 413,
    });
    await expect(store.store({ releaseId: 'r1', assetId: 'a1', bytes: new Uint8Array(17) })).resolves.toMatchObject({
      ok: false,
      status: 413,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(store.store({ releaseId: 'r1', assetId: 'a1', bytes })).resolves.toMatchObject({ ok: true, size: 3 });
    const loaded = await store.load({ releaseId: 'r1', assetId: 'a1' });
    expect(loaded).toBeInstanceOf(Uint8Array);
    expect([...(loaded as Uint8Array)]).toEqual([1, 2, 3]);
    await expect(store.remove({ releaseId: 'r1', assetId: 'a1' })).resolves.toEqual({ deleted: true });
  });

  it('masks fs failures instead of leaking internals', async () => {
    const secret = new Error('D1_SECRET_PATH=/tmp/secret');
    const failingFs = {
      promises: {
        mkdir: vi.fn(async () => undefined),
        writeFile: vi.fn(async () => {
          throw secret;
        }),
      },
    } as never;
    const failing = new ReleaseAssetStore(failingFs, {} as Env);
    const result = (await failing.store({ releaseId: 'r1', assetId: 'a1', bytes: new Uint8Array([1]) })) as {
      ok: boolean;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('failed to store asset');
    expect(result.error).not.toContain('SECRET');

    const empty = new ReleaseAssetStore(makeMemFs(), {} as Env);
    await expect(empty.load({ releaseId: 'r1', assetId: 'missing' })).resolves.toBeNull();
    await expect(empty.remove({ releaseId: 'r1', assetId: 'missing' })).resolves.toEqual({ deleted: false });
    await expect(empty.removeAll({ releaseId: 'r1' })).resolves.toEqual({ deleted: 0 });
  });
});

describe('RepoLifecycle targeted purge', () => {
  function makeLifecycle(rmdirImpl?: (path: string) => Promise<void>) {
    const rmdirs: string[] = [];
    const deletedKeys: string[] = [];
    const storage = {
      deleteAll: vi.fn(async () => undefined),
      delete: vi.fn(async (key: string) => {
        deletedKeys.push(key);
      }),
    };
    const isoGitFs = {
      promises: {
        rmdir: vi.fn(async (path: string) => {
          if (rmdirImpl) await rmdirImpl(path);
          rmdirs.push(path);
        }),
        stat: vi.fn(async () => ({}) as never),
      },
    };
    const git = { initRepo: vi.fn(async () => undefined) };
    const lifecycle = new RepoLifecycle(
      { storage } as never,
      {} as never,
      {} as never,
      isoGitFs as never,
      git as never,
      {} as never,
      () => undefined,
      async () => undefined,
    );
    return { lifecycle, rmdirs, deletedKeys, storage };
  }

  it('purges /repo + /release-assets and the name binding without dropping dofs tables', async () => {
    const { lifecycle, rmdirs, deletedKeys, storage } = makeLifecycle();
    await lifecycle.deleteRepo();
    expect(rmdirs).toEqual(['/repo', '/release-assets']);
    expect(deletedKeys).toEqual(['fullName']);
    expect(storage.deleteAll).not.toHaveBeenCalled();
  });

  it('tolerates repo paths that were never created', async () => {
    const { lifecycle, deletedKeys } = makeLifecycle(async () => {
      throw new Error('ENOENT');
    });
    await expect(lifecycle.deleteRepo()).resolves.toBeUndefined();
    expect(deletedKeys).toEqual(['fullName']);
  });
});

describe('RepoWorker thin-facade routing', () => {
  function makeWorker(parts: Record<string, unknown>) {
    const worker = Object.create(RepoWorker.prototype) as InstanceType<typeof RepoWorker>;
    Object.assign(worker, parts);
    return worker;
  }

  it('delegates reads to the read-model RPC fan-out', async () => {
    const reads = {
      getBranches: vi.fn(async () => ({ branches: ['main'], currentBranch: 'main' })),
      getLatestCommit: vi.fn(async () => ({ oid: OID_A })),
    };
    const worker = makeWorker({ reads });
    await expect(worker.getBranches()).resolves.toEqual({ branches: ['main'], currentBranch: 'main' });
    await worker.getLatestCommit('main');
    expect(reads.getLatestCommit).toHaveBeenCalledWith('main');
  });

  it('listRefs prepares via the lifecycle before reading git', async () => {
    const prepare = vi.fn(async () => undefined);
    const listRefs = vi.fn(async () => ({ refs: [], symbolicHead: null }));
    const worker = makeWorker({ lifecycle: { prepare }, git: { listRefs } });
    await worker.listRefs();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(listRefs).toHaveBeenCalledTimes(1);
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(listRefs.mock.invocationCallOrder[0]);
  });

  it('setFullName validates, persists once, and fullName throws when unset', async () => {
    const put = vi.fn(async () => undefined);
    const clearCache = vi.fn();
    const worker = makeWorker({
      ctx: { storage: { put, get: vi.fn(async () => null) } },
      git: { clearCache },
    });
    expect(() => worker.fullName).toThrow('Repository full name is not set');
    await expect(worker.setFullName('no-slash')).rejects.toThrow('Invalid repository full name');
    await expect(worker.setFullName('a/.hidden')).rejects.toThrow('Invalid repository full name');
    await worker.setFullName('alice/repo');
    expect(worker.fullName).toBe('alice/repo');
    expect(put).toHaveBeenCalledWith('fullName', 'alice/repo');
    // BREAKING: renames update the binding (old first-writer-wins ignored
    // renames and left storage drifting). Same-value sets stay idempotent.
    await worker.setFullName('alice/repo');
    expect(put).toHaveBeenCalledTimes(1);
    await worker.setFullName('bob/other');
    expect(put).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenLastCalledWith('fullName', 'bob/other');
    expect(worker.fullName).toBe('bob/other');
    expect(clearCache).toHaveBeenCalledTimes(1);
    // Case-correction within the same canonical key updates display case
    // without clearing the ref cache.
    await worker.setFullName('BOB/Other');
    expect(worker.fullName).toBe('BOB/Other');
    expect(clearCache).toHaveBeenCalledTimes(1);
  });

  it('deleteRepo delegates to the lifecycle and clears the cached name', async () => {
    const deleteRepo = vi.fn(async () => undefined);
    const worker = makeWorker({
      lifecycle: { deleteRepo },
      ctx: { storage: { put: vi.fn(async () => undefined), get: vi.fn(async () => null) } },
    });
    await worker.setFullName('alice/repo');
    await worker.deleteRepo();
    expect(deleteRepo).toHaveBeenCalledTimes(1);
    expect(() => worker.fullName).toThrow('Repository full name is not set');
  });

  it('fetch returns 404 for unknown paths', async () => {
    const worker = makeWorker({});
    const response = await worker.fetch(new Request('https://example.com/unknown-path'));
    expect(response.status).toBe(404);
  });

  it('receivePack and uploadPack dispatch with lifecycle limits', async () => {
    const limits = { maxWants: 1, maxHaves: 2, maxCommands: 3, maxObjects: 4, maxPackBytes: 5, maxFetchBodyBytes: 6 };
    const receivePack = vi.fn(async () => new Response('pushed'));
    const uploadPack = vi.fn(async () => new Response('fetched'));
    const worker = makeWorker({
      lifecycle: { getLimits: () => limits },
      pushHandler: { receivePack },
      fetchHandler: { uploadPack },
    });
    const data = new Uint8Array([1]);
    await worker.receivePack(data, []);
    expect(receivePack).toHaveBeenCalledWith(data, limits, []);
    await worker.uploadPack(data);
    expect(uploadPack).toHaveBeenCalledWith(data, limits);
  });
});

describe('RepoMove owner/org rename moves', () => {
  interface StubBehavior {
    refs: Array<{ ref: string; oid: string }>;
    oids: string[];
    pack: Uint8Array | null;
    importRefs: string[];
    listRefsError: Error | null;
    assets: Map<string, Uint8Array>;
  }

  interface World {
    env: Env;
    behaviors: Map<string, StubBehavior>;
    stubs: Map<string, Record<string, Fn>>;
    deleted: string[];
    ensured: string[];
  }

  function makeWorld(releases: Array<{ id: string }> = [], assets: Array<{ id: string }> = []): World {
    const behaviors = new Map<string, StubBehavior>();
    const stubs = new Map<string, Record<string, Fn>>();
    const deleted: string[] = [];
    const ensured: string[] = [];
    const getStub = (name: string): Record<string, Fn> => {
      const existing = stubs.get(name);
      if (existing) return existing;
      const behavior: StubBehavior = { refs: [], oids: [], pack: null, importRefs: [], listRefsError: null, assets: new Map() };
      behaviors.set(name, behavior);
      const stored: Array<{ releaseId: string; assetId: string; bytes: Uint8Array }> = [];
      const stub: Record<string, Fn> = {
        setFullName: vi.fn(async () => undefined),
        ensureRepoInitialized: vi.fn(async () => {
          ensured.push(name);
        }),
        listRefs: vi.fn(async () => {
          if (behavior.listRefsError) throw behavior.listRefsError;
          return { refs: behavior.refs, symbolicHead: null };
        }),
        exportPack: vi.fn(async () => ({ oids: behavior.oids, pack: behavior.pack })),
        importPack: vi.fn(async () => ({ importedRefs: behavior.importRefs })),
        getReleaseAsset: vi.fn(async (args: { releaseId: string; assetId: string }) => {
          return behavior.assets.get(`${args.releaseId}/${args.assetId}`) ?? null;
        }),
        storeReleaseAsset: vi.fn(async (args: { releaseId: string; assetId: string; bytes: Uint8Array }) => {
          stored.push(args);
          return { ok: true };
        }),
        deleteRepo: vi.fn(async () => {
          deleted.push(name);
        }),
      };
      (stub as Record<string, unknown>).storedAssets = stored as unknown;
      stubs.set(name, stub);
      return stub;
    };
    const db = {
      prepare: (sql: string) => ({
        bind: (..._params: unknown[]) => ({
          all: async <T>() => {
            if (sql.includes('release_assets')) return { results: assets as unknown as T[] };
            if (sql.includes('FROM releases')) return { results: releases as unknown as T[] };
            return { results: [] as unknown as T[] };
          },
          first: async <T>() => null as unknown as T | null,
          run: async () => ({ success: true }),
        }),
      }),
    };
    const env = { REPO: { getByName: (name: string) => getStub(name) }, DB: db } as unknown as Env;
    return { env, behaviors, stubs, deleted, ensured };
  }

  it('moveOneRepo on an empty source returns empty and purges the source', async () => {
    const world = makeWorld();
    const result = await moveOneRepo(world.env, 'al@example.com', {
      id: 'r1',
      name: 'repo',
      oldFull: 'old/repo',
      newFull: 'new/repo',
    });
    expect(result).toEqual({ empty: true });
    expect(world.deleted).toEqual(['old/repo']);
    expect(world.ensured).toEqual(['new/repo']);
  });

  it('moveOneRepo copies refs through a pack round-trip', async () => {
    const world = makeWorld();
    const byName = world.env.REPO as unknown as { getByName: (name: string) => Record<string, Fn> };
    byName.getByName('old/repo');
    byName.getByName('new/repo');
    const source = world.behaviors.get('old/repo');
    if (source) {
      source.refs = [{ ref: 'refs/heads/main', oid: OID_A }];
      source.oids = [OID_A];
      source.pack = new Uint8Array([9, 9]);
    }
    const targetBehavior = world.behaviors.get('new/repo');
    if (targetBehavior) targetBehavior.importRefs = ['refs/heads/main'];
    const result = await moveOneRepo(world.env, 'al@example.com', {
      id: 'r1',
      name: 'repo',
      oldFull: 'old/repo',
      newFull: 'new/repo',
    });
    expect(result).toEqual({ empty: false });
    const sourceStub = world.stubs.get('old/repo');
    expect(sourceStub?.exportPack).toHaveBeenCalledWith([OID_A]);
    const targetStub = world.stubs.get('new/repo');
    expect(targetStub?.importPack).toHaveBeenCalledWith(new Uint8Array([9, 9]), [
      { ref: 'refs/heads/main', oid: OID_A },
    ]);
    expect(world.deleted).toEqual(['old/repo']);
  });

  it('moveOneRepo failure purges the half-made target, keeps the source, and rethrows', async () => {
    const world = makeWorld();
    (world.env.REPO as unknown as { getByName: (name: string) => unknown }).getByName('old/repo');
    const behavior = world.behaviors.get('old/repo');
    if (behavior) behavior.listRefsError = new Error('copy boom');
    await expect(
      moveOneRepo(world.env, 'al@example.com', { id: 'r1', name: 'repo', oldFull: 'old/repo', newFull: 'new/repo' }),
    ).rejects.toThrow('copy boom');
    expect(world.deleted).toEqual(['new/repo']);
    expect(world.deleted).not.toContain('old/repo');
  });

  it('moveRepoDosForRename skips no-op moves and tallies moved/empty', async () => {
    const world = makeWorld();
    const result = await moveRepoDosForRename(world.env, 'al@example.com', [
      { id: 'r1', name: 'a', oldFull: 'o/a', newFull: 'n/a' },
      { id: 'r2', name: 'same', oldFull: 's/s', newFull: 's/s' },
    ]);
    expect(result).toEqual({ moved: 1, empty: 1 });
    expect(world.deleted).toEqual(['o/a']);
  });

  it('moveRepoDosForRename copies release-asset bytes driven by D1 metadata', async () => {
    const world = makeWorld([{ id: 'rel-1' }], [{ id: 'a1' }]);
    (world.env.REPO as unknown as { getByName: (name: string) => unknown }).getByName('o/a');
    world.behaviors.get('o/a')?.assets.set('rel-1/a1', new Uint8Array([5, 6]));
    const result = await moveRepoDosForRename(world.env, 'al@example.com', [
      { id: 'repo-id', name: 'a', oldFull: 'o/a', newFull: 'n/a' },
    ]);
    expect(result).toEqual({ moved: 1, empty: 1 });
    const target = world.stubs.get('n/a');
    expect(target?.storeReleaseAsset).toHaveBeenCalledWith({
      releaseId: 'rel-1',
      assetId: 'a1',
      bytes: new Uint8Array([5, 6]),
    });
  });

  it('moveRepoDosForRename compensates completed moves when a later move fails', async () => {
    const world = makeWorld();
    for (const name of ['o/good', 'o/bad']) {
      (world.env.REPO as unknown as { getByName: (name: string) => unknown }).getByName(name);
    }
    const bad = world.behaviors.get('o/bad');
    if (bad) bad.listRefsError = new Error('second move failed');
    await expect(
      moveRepoDosForRename(world.env, 'al@example.com', [
        { id: 'r1', name: 'good', oldFull: 'o/good', newFull: 'n/good' },
        { id: 'r2', name: 'bad', oldFull: 'o/bad', newFull: 'n/bad' },
      ]),
    ).rejects.toThrow('second move failed');
    // Failed move purged its half-made target; the completed move was rolled back.
    expect(world.deleted).toContain('n/bad');
    expect(world.deleted).toContain('n/good');
    // Rollback re-ensured the original name of the completed move.
    expect(world.ensured).toContain('o/good');
  });
});
