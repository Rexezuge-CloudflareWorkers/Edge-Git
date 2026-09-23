import { describe, expect, it } from 'vitest';
import { toBodyErrorStatus } from '../apps/api/src/workers/routes/BodyParser';
import { CollaborationService } from '../packages/backend-services/src/collab/CollaborationService';
import { TokenService } from '../packages/backend-services/src/auth/TokenService';
import { ReadModelService } from '../apps/background/src/ReadModelService';

describe('followup: body error status centralizes 413', () => {
  it('oversized wins over malformed', () => {
    expect(toBodyErrorStatus({ malformed: true, oversized: true })).toBe(413);
    expect(toBodyErrorStatus({ malformed: true, oversized: false })).toBe(400);
    expect(toBodyErrorStatus({ malformed: false, oversized: false })).toBeNull();
  });
});

describe('followup: getIssueMetas batches with per-item fallback', () => {
  it('returns empty meta on DAO failure', async () => {
    const svc = new CollaborationService(
      { DB: {} as never },
      {
        collaborationDAO: () =>
          Promise.resolve({
            listIssueLabels: async (id: string) => {
              if (id === 'bad') throw new Error('d1 down');
              return [{ name: 'bug' }];
            },
            listIssueAssignees: async () => ['a@x.com'],
          } as never),
      },
    );
    const out = await svc.getIssueMetas(['good', 'bad']);
    expect(out[0].labels).toHaveLength(1);
    expect(out[1]).toEqual({ labels: [], assignees: [] });
  });

  it('returns [] without DAO round-trip on empty input', async () => {
    let calls = 0;
    const svc = new CollaborationService(
      { DB: {} as never },
      {
        collaborationDAO: () => {
          calls += 1;
          return Promise.resolve({} as never);
        },
      },
    );
    await expect(svc.getIssueMetas([])).resolves.toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('followup: resolveGrantInputs validates before D1', () => {
  it('rejects bad shape without repo lookup', async () => {
    let lookups = 0;
    const svc = new TokenService(
      { DB: {} as never },
      {
        tokenDAO: () => Promise.resolve({} as never),
        repositoryDAO: () =>
          Promise.resolve({
            getByOwnerAndName: async () => {
              lookups += 1;
              return { id: 'r1' };
            },
          } as never),
        tokenGrantDAO: () => Promise.resolve({} as never),
      },
    );
    // @ts-expect-error private access for unit test
    await expect(svc.resolveGrantInputs('not-array')).rejects.toThrow();
    expect(lookups).toBe(0);
  });

  it('batches repo lookups concurrently', async () => {
    let lookups = 0;
    const svc = new TokenService(
      { DB: {} as never },
      {
        tokenDAO: () => Promise.resolve({} as never),
        repositoryDAO: () =>
          Promise.resolve({
            getByOwnerAndName: async (owner: string, name: string) => {
              lookups += 1;
              return { id: `${owner}/${name}` };
            },
          } as never),
        tokenGrantDAO: () => Promise.resolve({} as never),
      },
    );
    // @ts-expect-error private access for unit test
    const out = await svc.resolveGrantInputs([
      { owner: 'o', name: 'a', scope: 'repo:read' },
      { owner: 'o', name: 'b', scope: 'repo:write' },
    ]);
    expect(out).toHaveLength(2);
    expect(lookups).toBe(2);
  });
});

describe('followup: overview parallelizes independent reads', () => {
  it('shares one ref resolution across branches/tags/tree', async () => {
    const calls: string[] = [];
    const git = {
      listBranches: async () => {
        calls.push('branches');
        return ['main'];
      },
      currentBranch: async () => {
        calls.push('current');
        return 'main';
      },
      listTags: async () => {
        calls.push('tags');
        return [];
      },
      resolveRef: async () => 'abc',
      getTree: async () => [],
      getLastCommit: async () => null,
      getLog: async () => [],
    };
    const svc = new ReadModelService(git as never);
    const overview = await svc.getOverview({ includeTags: true });
    expect(overview.branches).toEqual(['main']);
    expect(calls).toContain('branches');
    expect(calls).toContain('current');
    expect(calls).toContain('tags');
  });
});
