import { describe, expect, it, vi } from 'vitest';
import { getRepoStub, ensureRepo, getCheckRunnerStub, getRealtimeStub } from '@/workers/doStubs';

describe('DO stub contracts', () => {
  it('getRepoStub resolves REPO.getByName and persists fullName best-effort', () => {
    const setFullName = vi.fn().mockResolvedValue(undefined);
    const env = { REPO: { getByName: vi.fn(() => ({ setFullName })) } } as unknown as Env;
    const stub = getRepoStub(env, 'alice/demo');
    expect(env.REPO.getByName).toHaveBeenCalledWith('alice/demo');
    expect(setFullName).toHaveBeenCalledWith('alice/demo');
    expect(stub).toBeDefined();
  });

  it('ensureRepo awaits setFullName + ensureRepoInitialized in order', async () => {
    const order: string[] = [];
    const env = {
      REPO: {
        getByName: vi.fn(() => ({
          setFullName: vi.fn(async () => void order.push('setFullName')),
          ensureRepoInitialized: vi.fn(async () => void order.push('ensure')),
        })),
      },
    } as unknown as Env;
    await ensureRepo(env, 'a/b');
    expect(order).toEqual(['setFullName', 'ensure']);
  });

  it('getCheckRunnerStub throws without binding (fail-closed)', () => {
    expect(() => getCheckRunnerStub({} as Env, 'a/b')).toThrow(/CHECK_RUNNER/);
  });

  it('getRealtimeStub throws without binding (fail-closed)', () => {
    expect(() => getRealtimeStub({} as Env, 'repo:a/b')).toThrow(/REALTIME/);
  });

  it('getCheckRunnerStub/getRealtimeStub resolve namespaced shards', () => {
    const checkGet = vi.fn(() => ({}));
    const realtimeGet = vi.fn(() => ({}));
    const env = { CHECK_RUNNER: { getByName: checkGet }, REALTIME: { getByName: realtimeGet } } as unknown as Env;
    getCheckRunnerStub(env, 'a/b');
    getRealtimeStub(env, 'repo:a/b');
    expect(checkGet).toHaveBeenCalledWith('a/b');
    expect(realtimeGet).toHaveBeenCalledWith('repo:a/b');
  });
});
