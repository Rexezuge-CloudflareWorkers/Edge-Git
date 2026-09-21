import { describe, expect, it } from 'vitest';
import { moveOneRepo, moveRepoDosForRename } from '@/workers/routes/RepoMove';

// Direct unit tests for the fail-closed rename-move orchestration.
// DO stubs are faked per full-name; ReleaseDAO comes from a permissive fake
// DB (no releases → asset copy short-circuits).

function moveEnv(stubs: Record<string, Record<string, (...args: never[]) => unknown>>, releases: unknown[] = []) {
  const db = {
    prepare: (query: string) => ({
      bind: (..._params: unknown[]) => ({
        first: async () => null,
        all: async <T>() => (query.includes('FROM releases WHERE') ? { results: releases as T[] } : { results: [] as T[] }),
        run: async () => ({ success: true }),
      }),
    }),
  };
  return {
    DB: db,
    REPO: {
      getByName: (fullName: string) => stubs[fullName] ?? { setFullName: async () => undefined },
      get: (fullName: string) => stubs[fullName] ?? { setFullName: async () => undefined },
      idFromName: (n: string) => n,
    },
    ENVIRONMENT: 'development',
  } as unknown as Env;
}

function gitStubs(refs: Array<{ ref: string; oid: string }> = [], failExport = false) {
  const deleted: string[] = [];
  const make = () => ({
    setFullName: async () => undefined,
    ensureRepoInitialized: async () => undefined,
    listRefs: async () => ({ refs, symbolicHead: null }),
    exportPack: failExport ? async () => Promise.reject(new Error('pack too large')) : async () => ({ oids: refs.map((r) => r.oid), pack: new Uint8Array([1]) }),
    importPack: async () => ({ importedRefs: refs.map((r) => r.ref) }),
    deleteRepo: async () => void deleted.push('x'),
    getReleaseAsset: async () => null,
  });
  return { make, deleted };
}

describe('RepoMove fail-closed orchestration', () => {
  it('moves an empty repo without copying', async () => {
    const { make } = gitStubs([]);
    const env = moveEnv({ 'alice/demo': make(), 'bob/demo': make() });
    const out = await moveRepoDosForRename(env, 'alice@example.com', [{ id: 'r1', name: 'demo', oldFull: 'alice/demo', newFull: 'bob/demo' }]);
    expect(out).toEqual({ moved: 1, empty: 1 });
  });

  it('copies refs for a non-empty repo', async () => {
    const refs = [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }];
    const { make } = gitStubs(refs);
    const env = moveEnv({ 'alice/demo': make(), 'bob/demo': make() });
    const out = await moveRepoDosForRename(env, 'alice@example.com', [{ id: 'r1', name: 'demo', oldFull: 'alice/demo', newFull: 'bob/demo' }]);
    expect(out).toEqual({ moved: 1, empty: 0 });
  });

  it('skips no-op and malformed moves', async () => {
    const { make } = gitStubs([]);
    const env = moveEnv({ 'a/b': make() });
    const out = await moveRepoDosForRename(env, 'a@x.com', [
      { id: 'r1', name: 'x', oldFull: 'a/b', newFull: 'a/b' },
      { id: 'r2', name: '', oldFull: '', newFull: 'c/d' },
    ]);
    expect(out).toEqual({ moved: 0, empty: 0 });
  });

  it('purges the half-made target and compensates completed moves on failure', async () => {
    const goodRefs = [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }];
    const good = gitStubs(goodRefs);
    const bad = gitStubs(goodRefs, true);
    const deletedTargets: string[] = [];
    const env = moveEnv({
      'alice/one': good.make(),
      'bob/one': good.make(),
      'alice/two': bad.make(),
      'bob/two': { ...bad.make(), deleteRepo: async () => void deletedTargets.push('bob/two') },
    });
    await expect(
      moveRepoDosForRename(env, 'alice@example.com', [
        { id: 'r1', name: 'one', oldFull: 'alice/one', newFull: 'bob/one' },
        { id: 'r2', name: 'two', oldFull: 'alice/two', newFull: 'bob/two' },
      ]),
    ).rejects.toThrow();
    expect(deletedTargets).toEqual(['bob/two']);
  });

  it('tolerates source and target purge failures', async () => {
    const refs = [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }];
    const failingDelete = { ...gitStubs(refs).make(), deleteRepo: async () => Promise.reject(new Error('DO busy')) };
    const env = moveEnv({ 'alice/demo': gitStubs(refs).make(), 'bob/demo': failingDelete });
    // Source purge failure is best-effort: the move still reports success.
    const out = await moveOneRepo(env, 'a@x.com', { id: 'r1', name: 'demo', oldFull: 'alice/demo', newFull: 'bob/demo' });
    expect(out.empty).toBe(false);
    // Target purge failure on the error path still rethrows the copy error.
    const bad = gitStubs(refs, true);
    const env2 = moveEnv({ 'alice/demo': bad.make(), 'bob/demo': failingDelete });
    await expect(moveOneRepo(env2, 'a@x.com', { id: 'r1', name: 'demo', oldFull: 'alice/demo', newFull: 'bob/demo' })).rejects.toThrow('pack too large');
  });

  it('reports false when the compensating copy-back fails', async () => {
    const refs = [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }];
    let exports = 0;
    const flaky = () => ({
      ...gitStubs(refs).make(),
      exportPack: async () => {
        exports += 1;
        // Move 2's source export (2nd) and the compensating copy-back (3rd) fail.
        if (exports >= 2) throw new Error('pack too large');
        return { oids: refs.map((r) => r.oid), pack: new Uint8Array([1]) };
      },
    });
    const env = moveEnv({ 'alice/one': flaky(), 'bob/one': flaky(), 'alice/two': flaky(), 'bob/two': flaky() });
    await expect(
      moveRepoDosForRename(env, 'alice@example.com', [
        { id: 'r1', name: 'one', oldFull: 'alice/one', newFull: 'bob/one' },
        { id: 'r2', name: 'two', oldFull: 'alice/two', newFull: 'bob/two' },
      ]),
    ).rejects.toThrow('pack too large');
  });

  it('tolerates purge failure during compensation', async () => {
    const refs = [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }];
    let exports = 0;
    const flakyExport = () => ({
      ...gitStubs(refs).make(),
      exportPack: async () => {
        exports += 1;
        if (exports === 2) throw new Error('pack too large');
        return { oids: refs.map((r) => r.oid), pack: new Uint8Array([1]) };
      },
    });
    const env = moveEnv({
      'alice/one': flakyExport(),
      'bob/one': { ...flakyExport(), deleteRepo: async () => Promise.reject(new Error('DO busy')) },
      'alice/two': flakyExport(),
      'bob/two': flakyExport(),
    });
    // Move 2 fails; compensating move 1 succeeds but its new-side purge rejects (caught).
    await expect(
      moveRepoDosForRename(env, 'alice@example.com', [
        { id: 'r1', name: 'one', oldFull: 'alice/one', newFull: 'bob/one' },
        { id: 'r2', name: 'two', oldFull: 'alice/two', newFull: 'bob/two' },
      ]),
    ).rejects.toThrow('pack too large');
  });

  it('tolerates release-asset read failures during copy', async () => {
    const refs = [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }];
    const lists = { releases: false, assets: false };
    const source = {
      ...gitStubs(refs).make(),
      getReleaseAsset: async () => Promise.reject(new Error('DO flap')),
    };
    const target = gitStubs(refs).make();
    const db = {
      prepare: (query: string) => ({
        bind: (..._params: unknown[]) => ({
          first: async () => null,
          all: async <T>() => {
            if (query.includes('FROM releases WHERE')) {
              lists.releases = true;
              return { results: [{ id: 'rel1' }] as unknown as T[] };
            }
            if (query.includes('FROM release_assets WHERE')) {
              lists.assets = true;
              return { results: [{ id: 'asset1' }] as unknown as T[] };
            }
            return { results: [] as T[] };
          },
          run: async () => ({ success: true }),
        }),
      }),
    };
    const env = {
      DB: db,
      REPO: { getByName: (name: string) => (name === 'alice/demo' ? source : target), get: (name: string) => (name === 'alice/demo' ? source : target), idFromName: (n: string) => n },
      ENVIRONMENT: 'development',
    } as unknown as Env;
    const out = await moveOneRepo(env, 'a@x.com', { id: 'r1', name: 'demo', oldFull: 'alice/demo', newFull: 'bob/demo' });
    expect(out.empty).toBe(false);
    expect(lists.releases && lists.assets).toBe(true);
  });

  it('skips asset copy when listings fail', async () => {
    const refs = [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }];
    const db = {
      prepare: (query: string) => ({
        bind: (..._params: unknown[]) => ({
          first: async () => null,
          all: async <T>() => {
            if (query.includes('FROM releases WHERE')) throw new Error('D1 flap');
            if (query.includes('FROM release_assets WHERE')) throw new Error('D1 flap');
            return { results: [] as T[] };
          },
          run: async () => ({ success: true }),
        }),
      }),
    };
    const env = {
      ...moveEnv({ 'alice/demo': gitStubs(refs).make(), 'bob/demo': gitStubs(refs).make() }),
      DB: db,
    } as unknown as Env;
    const out = await moveOneRepo(env, 'a@x.com', { id: 'r1', name: 'demo', oldFull: 'alice/demo', newFull: 'bob/demo' });
    expect(out.empty).toBe(false);
  });

  it('tolerates realtime publish failures', async () => {
    const { make } = gitStubs([]);
    const env = {
      ...moveEnv({ 'alice/demo': make(), 'bob/demo': make() }),
      REALTIME_ENABLED: 'true',
      REALTIME: { getByName: () => ({ publish: async () => Promise.reject(new Error('shard busy')) }) },
    } as unknown as Env;
    const out = await moveRepoDosForRename(env, 'alice@example.com', [{ id: 'r1', name: 'demo', oldFull: 'alice/demo', newFull: 'bob/demo' }]);
    expect(out).toEqual({ moved: 1, empty: 1 });
  });

  it('copies release assets and fails closed on store errors', async () => {
    const refs = [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }];
    const storeCalls: unknown[] = [];
    const asset = { id: 'asset1' };
    const release = { id: 'rel1' };
    const source = {
      ...gitStubs(refs).make(),
      getReleaseAsset: async () => new Uint8Array([9, 9]),
    };
    const target = {
      ...gitStubs(refs).make(),
      storeReleaseAsset: async (args: unknown) => {
        storeCalls.push(args);
        return { ok: false, error: 'disk full' };
      },
    };
    const db = {
      prepare: (query: string) => ({
        bind: (..._params: unknown[]) => ({
          first: async () => null,
          all: async <T>() => {
            if (query.includes('FROM releases WHERE')) return { results: [release] as unknown as T[] };
            if (query.includes('FROM release_assets WHERE')) return { results: [asset] as unknown as T[] };
            return { results: [] as T[] };
          },
          run: async () => ({ success: true }),
        }),
      }),
    };
    const env = {
      DB: db,
      REPO: { getByName: (name: string) => (name === 'alice/demo' ? source : target), get: (name: string) => (name === 'alice/demo' ? source : target), idFromName: (n: string) => n },
      ENVIRONMENT: 'development',
    } as unknown as Env;
    await expect(moveOneRepo(env, 'a@x.com', { id: 'r1', name: 'demo', oldFull: 'alice/demo', newFull: 'bob/demo' })).rejects.toThrow('disk full');
    expect(storeCalls).toHaveLength(1);
  });

  it('skips missing source assets (evicted bytes)', async () => {
    const refs = [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }];
    const stored: unknown[] = [];
    const source = { ...gitStubs(refs).make(), getReleaseAsset: async () => null };
    const target = { ...gitStubs(refs).make(), storeReleaseAsset: async (args: unknown) => void stored.push(args) };
    const db = {
      prepare: (query: string) => ({
        bind: (..._params: unknown[]) => ({
          first: async () => null,
          all: async <T>() => {
            if (query.includes('FROM releases WHERE')) return { results: [{ id: 'rel1' }] as unknown as T[] };
            if (query.includes('FROM release_assets WHERE')) return { results: [{ id: 'asset1' }] as unknown as T[] };
            return { results: [] as T[] };
          },
          run: async () => ({ success: true }),
        }),
      }),
    };
    const env = {
      DB: db,
      REPO: { getByName: (name: string) => (name === 'alice/demo' ? source : target), get: (name: string) => (name === 'alice/demo' ? source : target), idFromName: (n: string) => n },
      ENVIRONMENT: 'development',
    } as unknown as Env;
    const out = await moveOneRepo(env, 'a@x.com', { id: 'r1', name: 'demo', oldFull: 'alice/demo', newFull: 'bob/demo' });
    expect(out.empty).toBe(false);
    expect(stored).toHaveLength(0);
  });

  it('notifies the old realtime shard when enabled', async () => {
    const published: unknown[] = [];
    const { make } = gitStubs([]);
    const env = {
      ...moveEnv({ 'alice/demo': make(), 'bob/demo': make() }),
      REALTIME_ENABLED: 'true',
      REALTIME: { getByName: () => ({ publish: async (msg: unknown) => void published.push(msg) }) },
    } as unknown as Env;
    await moveRepoDosForRename(env, 'alice@example.com', [{ id: 'r1', name: 'demo', oldFull: 'alice/demo', newFull: 'bob/demo' }]);
    expect(published).toHaveLength(1);
  });
});
