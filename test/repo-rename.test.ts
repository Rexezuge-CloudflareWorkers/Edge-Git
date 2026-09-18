import { describe, expect, it } from 'vitest';
import { OrganizationService } from '@edge-git/backend-services/org';
import { cascadeOwnerRepos } from '@edge-git/backend-services/repo';
import { UserService } from '@edge-git/backend-services/user';

function sidecarSpy() {
  const calls: Array<{ repoId: string; fullName: string }> = [];
  return {
    calls,
    dao: async () =>
      ({
        updateFullNameByRepo: async (repoId: string, fullName: string) => {
          calls.push({ repoId, fullName });
        },
      }) as never,
  };
}

function pullSpy() {
  const base: Array<{ repoId: string; fullName: string }> = [];
  const head: Array<{ repoId: string; fullName: string }> = [];
  return {
    base,
    head,
    dao: async () =>
      ({
        updateFullNameByRepo: async (repoId: string, fullName: string) => {
          base.push({ repoId, fullName });
        },
        updateHeadFullNameByHeadRepo: async (repoId: string, fullName: string) => {
          head.push({ repoId, fullName });
        },
      }) as never,
  };
}

describe('cascadeOwnerRepos', () => {
  it('renames the owner and refreshes denormalized full names', async () => {
    const renamed: Array<{ oldCi: string; next: string }> = [];
    const forkSources: Array<{ id: string; fullName: string }> = [];
    const issues = sidecarSpy();
    const pulls = pullSpy();
    const events = sidecarSpy();
    const notifications = sidecarSpy();
    const webhooks = sidecarSpy();
    const moves = await cascadeOwnerRepos(
      {
        repositoryDAO: async () =>
          ({
            listByOwner: async () => [{ id: 'r1', name: 'demo' }],
            renameOwner: async (oldCi: string, next: string) => {
              renamed.push({ oldCi, next });
            },
            updateForkSourceFullName: async (id: string, fullName: string) => {
              forkSources.push({ id, fullName });
            },
          }) as never,
        issueDAO: issues.dao,
        pullRequestDAO: pulls.dao,
        eventDAO: events.dao,
        notificationDAO: notifications.dao,
        webhookDAO: webhooks.dao,
      },
      { oldOwnerCi: 'alice', newOwner: 'alice-new', now: 42 },
    );
    expect(renamed).toEqual([{ oldCi: 'alice', next: 'alice-new' }]);
    expect(moves).toEqual([{ id: 'r1', name: 'demo', oldFull: 'alice/demo', newFull: 'alice-new/demo' }]);
    for (const spy of [issues, events, notifications, webhooks]) {
      expect(spy.calls).toEqual([{ repoId: 'r1', fullName: 'alice-new/demo' }]);
    }
    expect(pulls.base).toEqual([{ repoId: 'r1', fullName: 'alice-new/demo' }]);
    expect(pulls.head).toEqual([{ repoId: 'r1', fullName: 'alice-new/demo' }]);
    expect(forkSources).toEqual([{ id: 'r1', fullName: 'alice-new/demo' }]);
  });

  it('tolerates fakes without snapshot or sidecar support', async () => {
    const renamed: Array<{ oldCi: string; next: string }> = [];
    const moves = await cascadeOwnerRepos(
      {
        repositoryDAO: async () =>
          ({
            renameOwner: async (oldCi: string, next: string) => {
              renamed.push({ oldCi, next });
            },
          }) as never,
      },
      { oldOwnerCi: 'alice', newOwner: 'alice-new', now: 42 },
    );
    expect(renamed).toEqual([{ oldCi: 'alice', next: 'alice-new' }]);
    expect(moves).toEqual([]);
  });
});

describe('rename services refresh sidecars', () => {
  it('UserService.renameUsername cascades issue full names', async () => {
    const issues = sidecarSpy();
    const svc = new UserService({ DB: {} } as never, {
      userDAO: async () =>
        ({
          getByEmail: async () => ({ email: 'a@x.co', username: 'old' }),
          getByUsernameCi: async () => null,
          setUsername: async () => undefined,
        }) as never,
      namespaceDAO: async () =>
        ({
          isTaken: async () => false,
          claim: async () => undefined,
          release: async () => undefined,
        }) as never,
      organizationDAO: async () => ({ getByUsernameCi: async () => null }) as never,
      repositoryDAO: async () =>
        ({
          listByOwner: async () => [{ id: 'r1', name: 'demo' }],
          renameOwner: async () => undefined,
          updateForkSourceFullName: async () => undefined,
        }) as never,
      issueDAO: issues.dao,
    });
    await svc.renameUsername('a@x.co', 'newhandle');
    expect(issues.calls).toEqual([{ repoId: 'r1', fullName: 'newhandle/demo' }]);
  });

  it('OrganizationService.rename covers org_id rows missing an owner match', async () => {
    const issues = sidecarSpy();
    const renamed: Array<{ oldCi: string; next: string }> = [];
    const svc = new OrganizationService({ DB: {} } as never, {
      organizationDAO: async () =>
        ({
          getByUsernameCi: async (ci: string) =>
            ci === 'acme' ? { id: 'o1', username: 'acme', username_ci: 'acme' } : null,
          getById: async () => ({ id: 'o1', username: 'acme-new', username_ci: 'acme-new' }),
          rename: async () => undefined,
        }) as never,
      organizationMemberDAO: async () => ({ get: async () => ({ role: 'owner' }) }) as never,
      namespaceDAO: async () =>
        ({
          isTaken: async () => false,
          release: async () => undefined,
          claim: async () => undefined,
        }) as never,
      userDAO: async () => ({ getByUsernameCi: async () => null }) as never,
      repositoryDAO: async () =>
        ({
          listByOrgId: async () => [{ id: 'r9', name: 'api' }],
          listByOwner: async () => [],
          renameOwner: async (oldCi: string, next: string) => {
            renamed.push({ oldCi, next });
          },
          updateForkSourceFullName: async () => undefined,
        }) as never,
      issueDAO: issues.dao,
    });
    await svc.rename('acme', 'owner@x.co', 'acme-new');
    expect(renamed).toEqual([{ oldCi: 'acme', next: 'acme-new' }]);
    expect(issues.calls).toEqual([{ repoId: 'r9', fullName: 'acme-new/api' }]);
  });
});
