import { vi } from 'vitest';

/**
 * An address registry with nothing in it — the pre-0028 shape, where the
 * account *is* the address and `user_emails` does not exist.
 *
 * The kit's `resolveAccount` treats an address with no registry row as
 * "look the `users` table up by anchor, then by sign-in address", and only
 * tolerates the *registry read* failing when the failure is a missing table. A
 * service test that injects a `userDAO` fake therefore has to say something
 * about the registry too: leaving it out makes the kit build a real
 * `UserEmailDAO` over `{}` and fail on `database.prepare`, which is a broken
 * fake rather than a legacy database.
 */
function emptyUserEmailRegistry(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    get: vi.fn(async () => null),
    resolveVerified: vi.fn(async () => null),
    listByUserId: vi.fn(async () => []),
    revoke: vi.fn(async () => undefined),
    revokeAllVerified: vi.fn(async () => undefined),
    register: vi.fn(async () => 'claimed' as const),
  };
}

/**
 * A `UserIdentityService` stand-in that resolves nothing, for a service test
 * that wires a `userDAO` fake but has no account-resolution story. Same
 * reasoning as {@link emptyUserEmailRegistry}: an absent resolution is a
 * result, not a crash.
 */
function stubIdentityService(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    resolveAccount: vi.fn(async () => null),
    resolveAccountId: vi.fn(async () => null),
    resolveAccountById: vi.fn(async () => null),
    resolveOrRegister: vi.fn(async () => null),
  };
}

export { emptyUserEmailRegistry, stubIdentityService };