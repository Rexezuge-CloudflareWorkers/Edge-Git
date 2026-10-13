import { stubIdentityService, emptyUserEmailRegistry } from './mocks/identity';
import { describe, expect, it } from 'vitest';
import { EdgeGitWorker } from '@/workers/EdgeGitWorker';
import { OrganizationService } from '@edge-git/backend-services/org';
import { RepoService } from '@edge-git/backend-services/repo';
import { UserService } from '@edge-git/backend-services/user';
import { RESERVED_NAMESPACE_NAMES, isReservedNamespaceName } from '@edge-git/shared/constants';

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };

function emptyDb() {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      }),
    }),
  };
}

describe('reserved namespace names (shared)', () => {
  it('covers worker, SPA, and future auth/product roots', () => {
    for (const name of [
      'health',
      'docs',
      'repos',
      'users',
      'user',
      'api',
      'settings',
      'new',
      'search',
      'notifications',
      'login',
      'admin',
      'orgs',
      'explore',
    ]) {
      expect(RESERVED_NAMESPACE_NAMES.has(name)).toBe(true);
    }
  });

  it('matches case-insensitively with surrounding whitespace trimmed', () => {
    expect(isReservedNamespaceName('Health')).toBe(true);
    expect(isReservedNamespaceName('  API  ')).toBe(true);
    expect(isReservedNamespaceName('ADMIN')).toBe(true);
    expect(isReservedNamespaceName('alice')).toBe(false);
    expect(isReservedNamespaceName('health-1')).toBe(false);
    expect(isReservedNamespaceName('')).toBe(false);
  });
});

describe('reserved namespace validation (services)', () => {
  it('rejects reserved usernames case-insensitively', () => {
    expect(() => UserService.validateUsername('health')).toThrow('reserved');
    expect(() => UserService.validateUsername('HEALTH')).toThrow('reserved');
    expect(() => UserService.validateUsername('api')).toThrow('reserved');
    expect(() => UserService.validateUsername('notifications')).toThrow('reserved');
    expect(() => UserService.validateUsername('bad name!')).toThrow('Invalid');
    expect(() => UserService.validateUsername('alice')).not.toThrow();
    expect(() => UserService.validateUsername('health-1')).not.toThrow();
  });

  it('rejects reserved organization names', () => {
    expect(() => OrganizationService.validateOrgName('docs')).toThrow('reserved');
    expect(() => OrganizationService.validateOrgName('Login')).toThrow('reserved');
    expect(() => OrganizationService.validateOrgName('bad name!')).toThrow('Invalid');
    expect(() => OrganizationService.validateOrgName('acme')).not.toThrow();
  });

  it('rejects reserved repo owners but allows reserved repo names', () => {
    expect(() => RepoService.validateNames('health', 'demo')).toThrow('reserved');
    expect(() => RepoService.validateNames('API', 'demo')).toThrow('reserved');
    expect(() => RepoService.validateNames('alice', 'health')).not.toThrow();
    expect(() => RepoService.validateNames('alice', 'demo')).not.toThrow();
  });

  it('rejects org create and user rename for reserved names before DAO checks', async () => {
    const orgSvc = new OrganizationService({ DB: {} } as never, {
      namespaceDAO: async () => ({ isTaken: async () => false }) as never,
      organizationDAO: async () => ({ getByUsernameCi: async () => null }) as never,
      userDAO: async () => ({ getByCurrentEmail: async () => null,
getByUsernameCi: async () => null }) as never,
userIdentity: async () => stubIdentityService() as never,
    });
    await expect(orgSvc.createOrganization('a@x.co', 'health')).rejects.toThrow('reserved');
    await expect(orgSvc.createOrganization('a@x.co', '  API ')).rejects.toThrow('reserved');

    const userSvc = new UserService({ DB: {} } as never, {
      userDAO: async () =>
        ({
          getByCurrentEmail: async () => null,
getByEmail: async () => ({ id: 'u-a', email: 'a@x.co', current_email: 'a@x.co', username: 'old' }),
          getById: async () => ({ id: 'u-a', email: 'a@x.co', current_email: 'a@x.co', username: 'old' }),
          getByUsernameCi: async () => null,
        }) as never,
      namespaceDAO: async () => ({ isTaken: async () => false }) as never,
      organizationDAO: async () => ({ getByUsernameCi: async () => null }) as never,
userEmailDAO: async () => emptyUserEmailRegistry() as never,
    });
    await expect(userSvc.renameUsername('a@x.co', 'docs')).rejects.toThrow('reserved');
  });

  it('skips reserved names when bootstrapping a username from email', async () => {
    const users = new Map<string, { id: string; email: string; current_email: string; username: string | null }>([
      ['health@example.com', { id: 'u-health', email: 'health@example.com', current_email: 'health@example.com', username: null }],
    ]);
    const namespaces = new Set<string>();
    const svc = new UserService({ DB: {} } as never, {
      userDAO: async () =>
        ({
          getByCurrentEmail: async () => null,
          // The kit's `registerAccount` reads `null` as "anchor already held".
          createUser: async (input: { anchor: string; loginEmail: string }) => {
            if (users.has(input.anchor)) return null;
            users.set(input.anchor, { id: `usr_${input.anchor}`, email: input.anchor, current_email: input.loginEmail, username: null });
            return `usr_${input.anchor}`;
          },
          getById: async (id: string) => [...users.values()].find((u) => u.id === id) ?? null,
          getByEmail: async (email: string) => users.get(email) ?? null,
          getByUsernameCi: async (ci: string) => [...users.values()].find((u) => u.username?.toLowerCase() === ci) ?? null,
          // `WHERE id = ? OR email = ?` — the service hands over whichever it has.
          ensureUsername: async (ref: string, handle: string) => {
            const row = users.get(ref) ?? [...users.values()].find((u) => u.id === ref);
            if (row) row.username = handle;
          },
        }) as never,
      namespaceDAO: async () =>
        ({
          isTaken: async (ci: string) => namespaces.has(ci),
          claimIgnore: async (input: { usernameCi: string }) => {
            namespaces.add(input.usernameCi);
          },
        }) as never,
      organizationDAO: async () => ({ getByUsernameCi: async () => null }) as never,
userEmailDAO: async () => emptyUserEmailRegistry() as never,
    });
    await svc.upsertUser('health@example.com');
    const bootstrapped = users.get('health@example.com')?.username ?? '';
    expect(bootstrapped.toLowerCase()).not.toBe('health');
    expect(isReservedNamespaceName(bootstrapped)).toBe(false);
    expect(bootstrapped.toLowerCase()).toBe('health-1');
  });
});

describe('reserved namespace worker shell', () => {
  it('returns 404 for reserved single-segment paths, shell for regular profiles', async () => {
    const worker = new EdgeGitWorker() as unknown as { onRequest(r: Request, e: unknown, c: unknown): Promise<Response> };
    const env = { DB: emptyDb() };
    // Reserved names that are not real app routes must never serve the profile shell.
    for (const path of ['/api', '/login', '/ADMIN', '/orgs']) {
      const res = await worker.onRequest(new Request(`https://git.example.com${path}`), env, ctx);
      expect(res.status).toBe(404);
    }
    // Real single-segment app routes keep serving the shell (not the profile fallback).
    const notifications = await worker.onRequest(new Request('https://git.example.com/notifications'), env, ctx);
    expect(notifications.status).toBe(200);
    expect(notifications.headers.get('content-type')).toContain('text/html');
    const shell = await worker.onRequest(new Request('https://git.example.com/alice'), env, ctx);
    expect(shell.status).toBe(200);
    expect(shell.headers.get('content-type')).toContain('text/html');
  });
});
