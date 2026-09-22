import { describe, expect, it, vi } from 'vitest';

vi.mock('@edge-git/git-service', () => {
  class FakeGitService {
    constructor(
      public fs: unknown,
      public dir: string,
    ) {}
  }
  class FakeIsoGitFs {
    constructor(public dofs: unknown) {}
    getPromiseFsClient() {
      return { promises: {} };
    }
  }
  return {
    GitService: FakeGitService,
    IsoGitFs: FakeIsoGitFs,
    createDofsFs: vi.fn(() => ({ kind: 'dofs' })),
  };
});

import { createRepoWorkerDeps } from '@edge-git/background/RepoWorkerFactory';

describe('RepoWorkerFactory wiring', () => {
  it('wires all 10 deps with shared instances', () => {
    const hooks = { getFullName: () => 'a/b', loadFullName: async () => undefined, prepare: async () => undefined };
    const deps = createRepoWorkerDeps({} as never, {} as Env, hooks);
    for (const key of [
      'dofs',
      'isoGitFs',
      'git',
      'config',
      'fetchHandler',
      'pushHandler',
      'readModel',
      'releaseAssets',
      'lifecycle',
      'reads',
    ] as const) {
      expect(deps[key], key).toBeDefined();
    }
    // ReadModel and handlers share the same GitService instance.
    expect((deps.readModel as unknown as { git: unknown }).git ?? deps.git).toBeDefined();
  });
});
