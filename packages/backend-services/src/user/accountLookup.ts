import { UserDAO, UserEmailDAO } from '@edge-git/backend-data/dao';

/**
 * A resolved account.
 *
 * `id` is the only value that should be used as an identity. `email` is the
 * address the account currently signs in with; `anchorEmail` is the immutable
 * internal value that legacy `*_email` columns and their foreign keys point at.
 */
export interface ResolvedAccount {
  id: string;
  email: string;
  anchorEmail: string;
  username: string | null;
}

/**
The trimmed, denormalized subset the user routes and permission path use.
*/
export type AccountSummary = Pick<ResolvedAccount, 'id' | 'email' | 'username'>;

export interface AccountLookupDeps {
  userDAO: () => Promise<UserDAO>;
  userEmailDAO: () => Promise<UserEmailDAO>;
}

/**
 * Address -> account resolution.
 *
 * The registry (`user_emails`) is the only mapping that survives an address
 * change, so it is consulted first; the `users` lookups are the floor for
 * databases that have not run migration 0028, where the address *is* the anchor.
 *
 * Kept as free functions rather than methods so the `UserService` god-file guard
 * has room, and so any service that needs an account id can share one
 * implementation instead of re-deriving the query.
 */
export async function resolveAccount(
  deps: AccountLookupDeps,
  email: string,
): Promise<ResolvedAccount | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const userDAO = await deps.userDAO();
  // A known address is authoritative: the registry says which account it
  // belongs to, and a *revoked* row (the account moved off this address) must
  // not resolve at all. Falling through to the legacy lookups in that case would
  // let a reassigned address keep authenticating the previous holder's account.
  try {
    const emailDAO = await deps.userEmailDAO();
    const registered = await emailDAO.get(normalized);
    if (registered) {
      // A revoked row (the account moved off this address) is authoritative and
      // must not resolve — otherwise a reassigned address would keep
      // authenticating the previous holder's account through the anchor lookup.
      if (registered.is_verified !== 1) return null;
      const byId = await userDAO.getById(registered.user_id);
      if (byId?.id) return summarize(byId.id, byId.current_email ?? byId.email, byId.username, byId.email);
      return null;
    }
  } catch {
    // Registry absent on a database that has not run 0028.
  }
  // No registry row at all. Safe to fall through: migration 0028 backfilled a
  // verified row for every anchor, so a row-less address is either new or on a
  // pre-0028 database, where the address *is* the anchor.
  // Pre-0028 floor: the address *is* the anchor, so a direct lookup is the only
  // way to resolve one. `getByCurrentEmail` is 0028-only, so injected fakes and
  // legacy databases may not have it.
  const byCurrent = typeof userDAO.getByCurrentEmail === 'function' ? await userDAO.getByCurrentEmail(normalized).catch(() => null) : null;
  const legacy = byCurrent ?? (await userDAO.getByEmail(normalized).catch(() => null));
  if (!legacy) return null;
  return summarize(legacy.id ?? '', legacy.current_email ?? legacy.email, legacy.username, legacy.email);
}

function summarize(id: string, current: string, username: string | null, anchor: string): ResolvedAccount {
  return { id, email: current.trim().toLowerCase(), anchorEmail: anchor, username: username ?? null };
}

/**
Account id for an address, or null when unknown.
*/
export async function resolveUserId(deps: AccountLookupDeps, email: string): Promise<string | null> {
  const account = await resolveAccount(deps, email);
  return account?.id || null;
}

/**
 * Insert an account and claim its sign-in address.
 *
 * The anchor is the address itself whenever it is free, which keeps every new
 * row shaped like the pre-0028 ones. It falls back to an opaque anchor only when
 * the address is already held as another account's anchor — i.e. its previous
 * holder moved off it — so a released address is never permanently unusable.
 *
 * Returns null when the insert could not produce a resolvable account, which
 * lets the caller retry with a different anchor.
 */
export async function registerAccount(
  deps: AccountLookupDeps,
  loginEmail: string,
  anchor: string,
  now: number,
): Promise<ResolvedAccount | null> {
  const userDAO = await deps.userDAO();
  const id = UserDAO.newId();
  // `createUser` stamps the 0028 identity columns; `upsertUser` is the pre-0028
  // shape, so injected fakes and legacy call sites still work. Both are no-ops
  // when the anchor is already taken, which is what makes the retry with a
  // different anchor safe.
  if (typeof userDAO.createUser === 'function') {
    await userDAO.createUser({ id, anchor, loginEmail, now });
  } else {
    await userDAO.upsertUser(anchor, now);
  }
  // Claim the sign-in address *before* resolving, otherwise the fresh account is
  // invisible to the registry and registration looks like a failure. An address
  // already verified for another account is left alone by `register`, and the
  // resolve below then reports that account instead.
  try {
    const emailDAO = await deps.userEmailDAO();
    await emailDAO.register({ email: loginEmail, userId: id, isVerified: true, now });
  } catch {
    // Registry absent (database predating 0028): the anchor is the address.
  }
  return resolveAccount(deps, loginEmail);
}
