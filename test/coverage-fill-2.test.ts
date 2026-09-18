import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cache } from '@edge-git/backend-runtime/cache';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { BaseScheduledTask } from '@edge-git/background/scheduled/IScheduledTask';
import { StarService } from '@edge-git/backend-services/social/StarService';
import { WatchService } from '@edge-git/backend-services/social/WatchService';
import { NotificationService } from '@edge-git/backend-services/social/NotificationService';

function installMemoryCache() {
  const store = new Map<string, Response>();
  const fakeCache = {
    async put(key: URL | Request | string, res: Response) {
      store.set(String(key), res.clone());
    },
    async match(key: URL | Request | string) {
      return store.get(String(key)) ?? undefined;
    },
  };
  (globalThis as unknown as { caches: { open: () => Promise<typeof fakeCache> } }).caches = {
    open: async () => fakeCache,
  };
  return store;
}

class ProbeTask extends BaseScheduledTask {
  public readonly name = 'ProbeTask';
  public readonly phase: 1 | 2 = 1;
  public calls: string[] = [];
  public constructor(private readonly fail: boolean = false) {
    super();
  }

  protected handleScheduledTask(): Promise<void> {
    this.calls.push('handled');
    if (this.fail) throw new Error('task-boom');
    return Promise.resolve();
  }
}

describe('cache helpers', () => {
  beforeEach(() => {
    installMemoryCache();
  });

  it('builds stable keys and round-trips json', async () => {
    const url = cache.buildCacheKey({ key: 'repos', params: { owner: 'alice', empty: undefined } });
    expect(url.pathname).toBe('/__cache/repos');
    expect(url.searchParams.get('owner')).toBe('alice');
    const custom = cache.buildCacheKey({ key: '/x', params: {}, baseUrl: 'https://example.com' });
    expect(custom.origin).toBe('https://example.com');
    await cache.putJson({ key: 'k1', data: { n: 1 }, params: {} });
    await expect(cache.getJson<{ n: number }>({ key: 'k1', params: {} })).resolves.toEqual({ n: 1 });
    await expect(cache.getJson({ key: 'missing', params: {} })).resolves.toBeNull();
  });

  it('getOrSetJson caches fetchers and skips nullish', async () => {
    let n = 0;
    const v1 = await cache.getOrSetJson({ key: 'g1', params: {}, fetcher: async () => ({ v: ++n }) });
    const v2 = await cache.getOrSetJson({ key: 'g1', params: {}, fetcher: async () => ({ v: ++n }) });
    expect(v1).toEqual({ v: 1 });
    expect(v2).toEqual({ v: 1 });
    expect(n).toBe(1);
    await expect(cache.getOrSetJson({ key: 'g-null', params: {}, fetcher: () => null as unknown as { v: number } })).resolves.toBeNull();
  });
});

describe('scheduled task template', () => {
  it('logs and delegates, propagating failures', async () => {
    const ok = new ProbeTask(false);
    await expect(ok.run({} as Env)).resolves.toBeUndefined();
    expect(ok.calls).toEqual(['handled']);
    const failing = new ProbeTask(true);
    await expect(failing.run({} as Env)).rejects.toThrow('task-boom');
  });
});

describe('social thin services', () => {
  it('StarService delegates with lowercased email', async () => {
    const calls: string[] = [];
    const fakeDao = {
      star: async (repo: string, email: string) => {
        calls.push(`star:${repo}:${email}`);
      },
      unstar: async (repo: string, email: string) => {
        calls.push(`unstar:${repo}:${email}`);
      },
      isStarred: async () => true,
      countByRepo: async () => 3,
      listRepoIdsByUser: async () => ['r1'],
    };
    const svc = new StarService({ DB: null as never }, { starDAO: async () => fakeDao as never });
    await svc.star('r1', 'A@X.com');
    await svc.unstar('r1', 'A@X.com');
    await expect(svc.isStarred('r1', 'a@x.com')).resolves.toBe(true);
    await expect(svc.countByRepo('r1')).resolves.toBe(3);
    await expect(svc.listRepoIdsByUser('A@X.com')).resolves.toEqual(['r1']);
    expect(calls).toEqual(['star:r1:a@x.com', 'unstar:r1:a@x.com']);
  });

  it('WatchService delegates including ensureWatching', async () => {
    const calls: string[] = [];
    const fakeDao = {
      watch: async (repo: string, email: string) => {
        calls.push(`watch:${repo}:${email}`);
      },
      unwatch: async () => undefined,
      isWatching: async () => false,
      countByRepo: async () => 0,
      listWatchers: async () => ['a@x.com'],
      listRepoIdsByUser: async () => [],
    };
    const svc = new WatchService({ DB: null as never }, { watchDAO: async () => fakeDao as never });
    await svc.watch('r1', 'B@Y.com');
    await svc.ensureWatching('r1', 'B@Y.com');
    await svc.unwatch('r1', 'b@y.com');
    await expect(svc.isWatching('r1', 'b@y.com')).resolves.toBe(false);
    await expect(svc.countByRepo('r1')).resolves.toBe(0);
    await expect(svc.listWatchers('r1')).resolves.toEqual(['a@x.com']);
    expect(calls).toEqual(['watch:r1:b@y.com', 'watch:r1:b@y.com']);
  });

  it('NotificationService marks read via fake DAO', async () => {
    const fakeDao = {
      markRead: async () => true,
      markAllRead: async () => 2,
      unreadCount: async () => 1,
      listByUser: async () => ({ notifications: [{ id: 'n1' }], nextCursor: null }),
      pruneReadOlderThan: async () => 0,
    };
    const svc = new NotificationService({ DB: null as never }, { notificationDAO: async () => fakeDao as never });
    await expect(svc.markRead('n1', 'a@x.com')).resolves.toBe(true);
    await expect(svc.markAllRead('a@x.com')).resolves.toBe(2);
    await expect(svc.unreadCount('a@x.com')).resolves.toBe(1);
    await expect(svc.listByUser('a@x.com')).resolves.toMatchObject({ nextCursor: null });
    await expect(svc.pruneReadOlderThan(1, 10)).resolves.toBe(0);
  });
});

describe('logger levels', () => {
  it('emits at or above the configured level', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const log = createLogger('TestScope');
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
      expect(infoSpy).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
