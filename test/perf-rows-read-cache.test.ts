import { describe, expect, it, vi } from 'vitest';
import { KV_DOMAINS } from '@edge-git/backend-runtime/kv';
import { KvCache } from '@edge-git/backend-runtime/kv';
import type { KvNamespaceLike } from '@edge-git/backend-runtime/kv';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
import { IsoGitFs } from '../packages/git-service/src/IsoGitFs';
import { RefService } from '../packages/git-service/src/RefService';
import {
  argsKeyFor,
  cacheControlFor,
  checkFetchLoop,
  etagForReadModel,
  invalidateRepoCaches,
  isFresh,
  putCachedRefs,
  serveReadModel,
} from '@/workers/routes/RepoReadCache';

// `RepoLifecycle` value-imports the git-service barrel (dofs →
// `cloudflare:workers`); stub the barrel like `repo-lifecycle.test.ts`.
vi.mock('@edge-git/git-service', () => ({ setDofsDeviceSize: vi.fn() }));
import { RepoLifecycle } from '@edge-git/background/RepoLifecycle';

function makeFakeKv(): KvNamespaceLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => Promise.resolve(store.delete(key)),
    list: (options: { prefix: string }) => {
      const keys = [...store.keys()].filter((k) => k.startsWith(options.prefix)).map((name) => ({ name }));
      return Promise.resolve({ keys, list_complete: true });
    },
  };
}

describe('KV liveness', () => {
  it('keeps refs for 24h and adds a readmodel domain', () => {
    expect(KV_DOMAINS.refs.ttlSeconds).toBe(86_400);
    expect(KV_DOMAINS.readmodel.ttlSeconds).toBe(600);
    expect(KV_DOMAINS.readmodel.maxValueBytes).toBe(1_048_576);
  });
});

describe('RepoLifecycle warm fast path', () => {
  it('skips the HEAD stat after the first prepare', async () => {
    const stat = vi.fn(async () => ({}) as never);
    const isoGitFs = { promises: { stat, rmdir: vi.fn() } } as never;
    const lifecycle = new RepoLifecycle(
      { storage: { delete: vi.fn() } } as never,
      {} as never,
      { setDeviceSize: vi.fn() } as never,
      isoGitFs,
      { ensureFreshCache: vi.fn(), initRepo: vi.fn() } as never,
      AppConfiguration.fromEnv({}),
      () => 'a/b',
      async () => undefined,
    );
    await lifecycle.ensureRepoInitialized();
    await lifecycle.ensureRepoInitialized();
    expect(stat).toHaveBeenCalledTimes(1);
    await lifecycle.deleteRepo();
    await lifecycle.ensureRepoInitialized();
    expect(stat).toHaveBeenCalledTimes(2);
  });
});

describe('IsoGitFs object fast path', () => {
  it('skips readlink for content-addressed objects', async () => {
    const readlink = vi.fn(() => {
      throw new Error('ENOENT');
    });
    const statFn = vi.fn(() => ({ isFile: true, isDirectory: false }) as never);
    const dofs = { readlink, stat: statFn } as never;
    const fs = new IsoGitFs(dofs);
    await fs.lstat('/repo/objects/ab/cdef');
    expect(readlink).not.toHaveBeenCalled();
    await fs.lstat('/repo/refs/heads/main');
    expect(readlink).toHaveBeenCalledTimes(1);
  });
});

describe('RefService batching', () => {
  it('resolves branches from one packed-refs read with capped concurrency', async () => {
    const packed = 'aaaa'.padEnd(40, 'a') + ' refs/heads/a\n' + 'b'.repeat(40) + ' refs/heads/b\n';
    const files: Record<string, string> = { '/repo/packed-refs': packed };
    const readFile = vi.fn(async (path: string) => {
      if (path in files) return files[path] as never;
      throw new Error('ENOENT');
    });
    const fs = { promises: { readFile } } as never;
    const git = await import('isomorphic-git');
    const listBranches = vi.spyOn(git, 'listBranches').mockResolvedValue(['a', 'b'] as never);
    const resolveRef = vi.spyOn(git, 'resolveRef');
    try {
      const svc = new RefService(fs, '/repo');
      const out = await svc.listBranchesWithOid();
      expect(out).toHaveLength(2);
      expect(readFile).toHaveBeenCalledTimes(3);
      expect(resolveRef).not.toHaveBeenCalled();
    } finally {
      listBranches.mockRestore();
      resolveRef.mockRestore();
    }
  });
});

describe('RepoReadCache', () => {
  it('builds stable etags and detects fresh requests', () => {
    const etag = etagForReadModel('a'.repeat(40), 'overview', argsKeyFor({ ref: 'main' }));
    expect(etag).toContain('overview');
    const req = new Request('https://x/', { headers: { 'If-None-Match': etag } });
    expect(isFresh(req, etag)).toBe(true);
    expect(isFresh(new Request('https://x/'), etag)).toBe(false);
    expect(cacheControlFor('overview')).toContain('max-age=30');
    expect(cacheControlFor('commits/abc', true)).toContain('immutable');
  });

  it('serves 304 without DO I/O when refs are cached', async () => {
    const cache = new KvCache(makeFakeKv());
    await putCachedRefs(cache, 'Foo/Bar', { refs: [{ ref: 'HEAD', oid: 'a'.repeat(40) }], symbolicHead: 'refs/heads/main' });
    const load = vi.fn(async () => ({ ok: true }));
    const c = {
      req: { raw: new Request('https://x/', { headers: { 'If-None-Match': etagForReadModel('a'.repeat(40), 'branches', argsKeyFor({})) } }) },
      json: (data: unknown) => new Response(JSON.stringify(data)),
    } as never;
    const res = await serveReadModel(c, cache, 'foo/bar', 'branches', {}, load, {});
    expect(res.status).toBe(304);
    expect(load).not.toHaveBeenCalled();
  });

  it('caches DO results and invalidates them', async () => {
    const kv = makeFakeKv();
    const cache = new KvCache(kv);
    const c = { req: { raw: new Request('https://x/') }, json: (data: unknown) => new Response(JSON.stringify(data)) } as never;
    const first = await serveReadModel(c, cache, 'a/b', 'branches', {}, async () => ['main'], {
      fetchRefs: async () => ({ refs: [{ ref: 'HEAD', oid: 'b'.repeat(40) }], symbolicHead: null }),
    });
    expect(first.status).toBe(200);
    const load = vi.fn(async () => ['stale']);
    const c2 = { req: { raw: new Request('https://x/') }, json: (data: unknown) => new Response(JSON.stringify(data)) } as never;
    const second = await serveReadModel(c2, cache, 'a/b', 'branches', {}, load, {});
    expect(load).not.toHaveBeenCalled();
    expect(second.headers.get('ETag')).toBe(first.headers.get('ETag'));
    await invalidateRepoCaches(cache, 'a/b');
    const c3 = { req: { raw: new Request('https://x/') }, json: (data: unknown) => new Response(JSON.stringify(data)) } as never;
    await serveReadModel(c3, cache, 'a/b', 'branches', {}, load, {
      fetchRefs: async () => ({ refs: [{ ref: 'HEAD', oid: 'c'.repeat(40) }], symbolicHead: null }),
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('429s repeated identical fetches', async () => {
    const cache = new KvCache(makeFakeKv());
    const body = new Uint8Array([1, 2, 3]);
    for (let i = 0; i < 5; i += 1) {
      const out = await checkFetchLoop(cache, 'a/b', 'ip:1', body);
      expect(out.allowed).toBe(true);
    }
    const blocked = await checkFetchLoop(cache, 'a/b', 'ip:1', body);
    expect(blocked.allowed).toBe(false);
  });
});
