import { describe, expect, it, vi } from 'vitest';
import { RepoFullName, repoDoKey, repoDoKeyForFullName } from '@edge-git/shared/utils';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
import { RepoLifecycle } from '@edge-git/background/RepoLifecycle';
import { RATE_LIMIT_DEFS } from '@/middleware/rateLimitConfig';

vi.mock('@edge-git/git-service', () => ({ setDofsDeviceSize: vi.fn() }));

describe('hardening: canonical DO keys (breaking)', () => {
  it('lowercases owner and name for routing', () => {
    expect(repoDoKey('Foo', 'Bar')).toBe('foo/bar');
    expect(repoDoKeyForFullName('Foo/Bar')).toBe('foo/bar');
    expect(repoDoKey('Alice', 'MyRepo.git')).toBe('alice/myrepo');
  });

  it('RepoFullName.toDoKey matches helpers', () => {
    const parsed = RepoFullName.tryParse('Foo', 'Bar');
    expect(parsed?.toDoKey()).toBe('foo/bar');
  });

  it('routes getByName canonically while preserving display case via setFullName', async () => {
    const seen: string[] = [];
    let stored: string | undefined;
    const fakeEnv = {
      REPO: {
        getByName: (key: string) => {
          seen.push(key);
          return {
            setFullName: async (display: string) => {
              stored = display;
            },
            ensureRepoInitialized: async () => undefined,
          };
        },
      },
    };
    const { getRepoStub, ensureRepo } = await import('@/workers/doStubs');
    getRepoStub(fakeEnv as unknown as Env, 'Foo/Bar');
    expect(seen[0]).toBe('foo/bar');
    await ensureRepo(fakeEnv as unknown as Env, 'Foo/Bar');
    // ensureRepo persists display case inside the DO, not the lowered key.
    expect(stored).toBe('Foo/Bar');
    expect(seen[1]).toBe('foo/bar');
  });
});

describe('hardening: DO device size via config', () => {
  it('defaults to 5GB and honors DO_DEVICE_BYTES', () => {
    expect(AppConfiguration.fromEnv({}).getDoDeviceBytes()).toBe(5 * 1024 * 1024 * 1024);
    expect(AppConfiguration.fromEnv({ DO_DEVICE_BYTES: '123' }).getDoDeviceBytes()).toBe(123);
    expect(AppConfiguration.fromEnv({ DO_DEVICE_BYTES: 'nope' }).getDoDeviceBytes()).toBe(5 * 1024 * 1024 * 1024);
  });
});

describe('hardening: table-driven rate limits', () => {
  it('covers git + user surfaces with unique key prefixes per path group', () => {
    expect(RATE_LIMIT_DEFS.length).toBeGreaterThanOrEqual(30);
    const git = RATE_LIMIT_DEFS.slice(0, 3).map((d) => d.keyPrefix);
    expect(git).toEqual(['git-fetch', 'git-push', 'git-refs']);
    const prefixes = RATE_LIMIT_DEFS.map((d) => `${d.path}#${d.keyPrefix}`);
    expect(new Set(prefixes).size).toBe(RATE_LIMIT_DEFS.length);
    for (const def of RATE_LIMIT_DEFS) {
      expect(def.windowMs).toBe(60_000);
      expect(def.max).toBeGreaterThan(0);
    }
  });
});

describe('hardening: RepoLifecycle single-flight init', () => {
  it('shares one init across concurrent ensures and retries after failure', async () => {
    let inits = 0;
    let headExists = false;
    const fakeFs = {
      promises: {
        stat: async () => {
          if (!headExists) throw new Error('no HEAD');
        },
      },
    };
    const fakeGit = {
      initRepo: async () => {
        inits += 1;
        headExists = true;
      },
    };
    const config = AppConfiguration.fromEnv({});
    const lifecycle = new RepoLifecycle(
      {} as DurableObjectState,
      {} as Env,
      {} as never,
      fakeFs as never,
      fakeGit as never,
      config,
      () => 'foo/bar',
      async () => undefined,
    );
    await Promise.all([lifecycle.ensureRepoInitialized(), lifecycle.ensureRepoInitialized()]);
    expect(inits).toBe(1);
    // Second generation after success re-stats and short-circuits.
    await lifecycle.ensureRepoInitialized();
    expect(inits).toBe(1);
  });

  it('clears only its own failed generation so the next call retries', async () => {
    let attempts = 0;
    const fakeFs = {
      promises: {
        stat: async () => {
          throw new Error('no HEAD');
        },
      },
    };
    const fakeGit = {
      initRepo: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('init boom');
      },
    };
    const lifecycle = new RepoLifecycle(
      {} as DurableObjectState,
      {} as Env,
      {} as never,
      fakeFs as never,
      fakeGit as never,
      AppConfiguration.fromEnv({}),
      () => 'foo/bar',
      async () => undefined,
    );
    await expect(lifecycle.ensureRepoInitialized()).rejects.toThrow('init boom');
    await lifecycle.ensureRepoInitialized();
    expect(attempts).toBe(2);
  });
});
