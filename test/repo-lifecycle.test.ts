import { describe, expect, it, vi } from 'vitest';
import { RepoLifecycle } from '@edge-git/background/RepoLifecycle';

// `RepoLifecycle` value-imports `setDofsDeviceSize` from git-service, which
// pulls `dofs` → `cloudflare:workers` (unavailable in the node unit pool).
// Stub the module: this suite injects all collaborators as fakes anyway.
vi.mock('@edge-git/git-service', () => ({ setDofsDeviceSize: vi.fn() }));

function createLifecycle(rmdirImpl?: (path: string) => Promise<void>) {
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
  return { lifecycle, rmdirs, deletedKeys, storage, isoGitFs, git };
}

describe('RepoLifecycle.deleteRepo', () => {
  it('purges repo content without dropping the dofs schema', async () => {
    const { lifecycle, rmdirs, deletedKeys, storage } = createLifecycle();
    await lifecycle.deleteRepo();
    // Regression: `storage.deleteAll()` wiped `dofs_files/dofs_chunks/dofs_meta`
    // on the warm DO isolate, so recreating the same repo name 500'd.
    expect(rmdirs).toEqual(['/repo', '/release-assets']);
    expect(deletedKeys).toEqual(['fullName']);
    expect(storage.deleteAll).not.toHaveBeenCalled();
  });

  it('tolerates paths that were never created', async () => {
    const { lifecycle, deletedKeys } = createLifecycle(async () => {
      throw new Error('ENOENT');
    });
    await expect(lifecycle.deleteRepo()).resolves.toBeUndefined();
    expect(deletedKeys).toEqual(['fullName']);
  });
});

describe('RepoLifecycle.ensureRepoInitialized', () => {
  it('inits only when HEAD is missing', async () => {
    const { lifecycle, git, isoGitFs } = createLifecycle();
    await lifecycle.ensureRepoInitialized();
    expect(git.initRepo).not.toHaveBeenCalled();

    // Warm fast path: a second prepare on the same isolate skips the stat.
    await lifecycle.ensureRepoInitialized();
    expect(isoGitFs.promises.stat).toHaveBeenCalledTimes(1);
    expect(git.initRepo).not.toHaveBeenCalled();
  });

  it('inits on a fresh isolate when HEAD is missing', async () => {
    const { lifecycle, git, isoGitFs } = createLifecycle();
    isoGitFs.promises.stat.mockRejectedValueOnce(new Error('ENOENT'));
    await lifecycle.ensureRepoInitialized();
    expect(git.initRepo).toHaveBeenCalledTimes(1);
  });
});
