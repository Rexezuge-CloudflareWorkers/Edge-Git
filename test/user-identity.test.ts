import { describe, expect, it } from 'vitest';
import { UserEmailDAO, type UserEmailRow } from '@edge-git/backend-data/dao';
import type { UserRow } from '@edge-git/backend-data/dao';
import { UserIdentityService } from '@edge-git/backend-services/identity';
import { UserService } from '@edge-git/backend-services/user';

/**
 * Account identity across an address change.
 *
 * The invariant under test: an account's id — not its address — is what owns
 * repositories, grants, and tokens, so moving the address moves neither.
 */

interface FakeUserRow extends UserRow {
  id: string;
  email: string;
  current_email: string;
  username: string | null;
}

function createIdentityDeps(seed: Array<{ id: string; anchor: string; current: string; username?: string | null }>) {
  const users: FakeUserRow[] = seed.map((s) => ({
    id: s.id,
    email: s.anchor,
    current_email: s.current,
    username: s.username ?? null,
    created_at: 0,
    updated_at: null,
  }));
  const registry = new Map<string, UserEmailRow>();
  for (const s of seed) {
    registry.set(s.current.toLowerCase(), { email: s.current.toLowerCase(), user_id: s.id, is_verified: 1, created_at: 0 });
  }

  const userDAO = {
    getById: async (id: string) => users.find((u) => u.id === id) ?? null,
    getByEmail: async (email: string) => users.find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null,
    getByCurrentEmail: async (email: string) => users.find((u) => u.current_email.toLowerCase() === email.toLowerCase()) ?? null,
    setCurrentEmail: async (id: string, email: string) => {
      const row = users.find((u) => u.id === id);
      if (row) row.current_email = email.toLowerCase();
    },
  };
  const userEmailDAO = {
    get: async (email: string) => registry.get(email.toLowerCase()) ?? null,
    resolveVerified: async (email: string) => {
      const row = registry.get(email.toLowerCase());
      return row && row.is_verified === 1 ? row : null;
    },
    register: async (input: { email: string; userId: string; isVerified: boolean; now: number }) => {
      const key = input.email.toLowerCase();
      const existing = registry.get(key);
      if (existing && existing.is_verified === 1) return 'already-claimed' as const;
      registry.set(key, { email: key, user_id: input.userId, is_verified: input.isVerified ? 1 : 0, created_at: input.now });
      return 'claimed' as const;
    },
    revokeAllVerified: async (userId: string, exceptEmail: string) => {
      for (const [key, row] of registry) {
        if (row.user_id === userId && key !== exceptEmail.toLowerCase()) registry.set(key, { ...row, is_verified: 0 });
      }
    },
  };
  return { users, registry, userDAO, userEmailDAO };
}

const ALICE_ID = 'usr_'.padEnd(36, 'a');
const BOB_ID = 'usr_'.padEnd(36, 'b');

describe('UserIdentityService', () => {
  it('resolves a sign-in address to its account', async () => {
    const d = createIdentityDeps([{ id: ALICE_ID, anchor: 'alice@old.test', current: 'alice@old.test', username: 'alice' }]);
    const svc = new UserIdentityService({ DB: {} } as never, {
      userDAO: async () => d.userDAO as never,
      userEmailDAO: async () => d.userEmailDAO as never,
    });
    await expect(svc.resolveUserId('alice@old.test')).resolves.toBe(ALICE_ID);
    await expect(svc.resolveAccount('ALICE@OLD.TEST')).resolves.toMatchObject({ id: ALICE_ID, email: 'alice@old.test' });
    await expect(svc.resolveUserId('nobody@x.test')).resolves.toBeNull();
    await expect(svc.resolveUserId('not-an-email')).resolves.toBeNull();
  });

  it('changes the sign-in address without changing the account', async () => {
    const d = createIdentityDeps([{ id: ALICE_ID, anchor: 'alice@old.test', current: 'alice@old.test', username: 'alice' }]);
    const svc = new UserIdentityService({ DB: {} } as never, {
      userDAO: async () => d.userDAO as never,
      userEmailDAO: async () => d.userEmailDAO as never,
    });

    const moved = await svc.setPrimaryEmail(ALICE_ID, 'Alice@New.test');
    expect(moved.id).toBe(ALICE_ID);
    expect(moved.email).toBe('alice@new.test');
    // The anchor is frozen, which is what keeps every legacy `*_email` value
    // and its foreign key resolving.
    expect(d.users[0]?.email).toBe('alice@old.test');
    expect(d.users[0]?.current_email).toBe('alice@new.test');

    // The new address authenticates the same account...
    await expect(svc.resolveUserId('alice@new.test')).resolves.toBe(ALICE_ID);
    // ...and the old one no longer does, so a reassigned address cannot
    // inherit the account.
    await expect(svc.resolveUserId('alice@old.test')).resolves.toBeNull();
    // The revoked row is retained for attribution.
    expect(d.registry.get('alice@old.test')?.is_verified).toBe(0);
    expect(d.registry.get('alice@old.test')?.user_id).toBe(ALICE_ID);
  });

  it('refuses an address already held by another account', async () => {
    const d = createIdentityDeps([
      { id: ALICE_ID, anchor: 'alice@old.test', current: 'alice@old.test' },
      { id: BOB_ID, anchor: 'shared@x.test', current: 'shared@x.test' },
    ]);
    const svc = new UserIdentityService({ DB: {} } as never, {
      userDAO: async () => d.userDAO as never,
      userEmailDAO: async () => d.userEmailDAO as never,
    });
    // Taking over a live address would hand Bob's account to Alice, which is
    // the account-takeover vector the check exists to close.
    await expect(svc.setPrimaryEmail(ALICE_ID, 'shared@x.test')).rejects.toThrow(/already in use/);
    expect(d.users.find((u) => u.id === ALICE_ID)?.current_email).toBe('alice@old.test');
  });

  it('releases a revoked address for a later legitimate holder', async () => {
    const d = createIdentityDeps([{ id: ALICE_ID, anchor: 'alice@old.test', current: 'alice@old.test' }]);
    const svc = new UserIdentityService({ DB: {} } as never, {
      userDAO: async () => d.userDAO as never,
      userEmailDAO: async () => d.userEmailDAO as never,
    });
    await svc.setPrimaryEmail(ALICE_ID, 'alice@new.test');
    await expect(svc.linkVerifiedEmail(BOB_ID, 'alice@old.test')).resolves.toBeUndefined();
    // Re-pointed, so the previous holder's history is not inherited.
    expect(d.registry.get('alice@old.test')?.user_id).toBe(BOB_ID);
  });

  it('is idempotent when the address does not change', async () => {
    const d = createIdentityDeps([{ id: ALICE_ID, anchor: 'alice@old.test', current: 'alice@old.test' }]);
    const svc = new UserIdentityService({ DB: {} } as never, {
      userDAO: async () => d.userDAO as never,
      userEmailDAO: async () => d.userEmailDAO as never,
    });
    await expect(svc.setPrimaryEmail(ALICE_ID, 'ALICE@OLD.TEST')).resolves.toMatchObject({ id: ALICE_ID });
    expect(d.users[0]?.current_email).toBe('alice@old.test');
  });

  it('rejects a malformed address', async () => {
    const d = createIdentityDeps([{ id: ALICE_ID, anchor: 'alice@old.test', current: 'alice@old.test' }]);
    const svc = new UserIdentityService({ DB: {} } as never, {
      userDAO: async () => d.userDAO as never,
      userEmailDAO: async () => d.userEmailDAO as never,
    });
    await expect(svc.setPrimaryEmail(ALICE_ID, 'nope')).rejects.toThrow(/Invalid email/);
  });
});

describe('UserService account registration', () => {
  it('registers once and reuses the same account for a known address', async () => {
    const d = createIdentityDeps([]);
    const inserts: string[] = [];
    const svc = new UserService({ DB: {} } as never, {
      userDAO: async () =>
        ({
          ...d.userDAO,
          createUser: async (input: { id?: string | null; anchor: string; loginEmail: string; now: number }) => {
            inserts.push(input.anchor);
            if (d.users.some((u) => u.email === input.anchor)) return;
            d.users.push({
              id: input.id ?? `usr_${String(inserts.length).padStart(32, '0')}`,
              email: input.anchor,
              current_email: input.loginEmail,
              username: null,
              created_at: input.now,
              updated_at: null,
            });
          },
          ensureUsername: async (ref: string, handle: string) => {
            const row = d.users.find((u) => u.id === ref || u.email === ref);
            if (row) row.username = handle;
          },
          getByUsernameCi: async () => null,
        }) as never,
      userEmailDAO: async () => d.userEmailDAO as never,
      namespaceDAO: async () => ({ isTaken: async () => false, claimIgnore: async () => undefined }) as never,
      organizationDAO: async () => ({ getByUsernameCi: async () => null }) as never,
    });

    const first = await svc.upsertUser('Alice@Example.com');
    const second = await svc.upsertUser('alice@example.com');
    // A second sign-in with the same address must not fork a second account.
    expect(inserts).toHaveLength(1);
    expect(first.id).toBe(second.id);
    expect(second.username).toBe('alice');
  });
});
