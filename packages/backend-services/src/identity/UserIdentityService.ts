import { UserDAO, UserEmailDAO } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError, ConflictError, DatabaseError } from '@edge-git/backend-errors';
import { EmailAddress, isValidEmailFormat } from '@edge-git/shared/utils';
import { TimestampUtil } from '@edge-git/shared/utils';

interface UserIdentityEnv {
  DB: D1Queryable;
}

interface UserIdentityDeps {
  userDAO?: () => Promise<UserDAO>;
  userEmailDAO?: () => Promise<UserEmailDAO>;
}

/**
 * A resolved account. `id` is the only thing that should be used as an
 * identity; `email` is the address the account currently signs in with, and
 * `anchorEmail` is the internal value legacy `*_email` columns store.
 */
interface AccountIdentity {
  id: string;
  email: string;
  anchorEmail: string;
  username: string | null;
}

function normalize(email: string): string {
  return EmailAddress.normalize(email);
}

/**
 * The account behind an address.
 *
 * Resolution is address → `user_emails` → `users.id`, so an account keeps
 * working after it changes its address: the new address resolves through the
 * registry to the same id that every repository, grant, and token points at.
 * Results are memoized for the lifetime of the instance, which is one request
 * scope — the permission path resolves the same viewer repeatedly.
 */
class UserIdentityService {
  private readonly deps: Required<UserIdentityDeps>;
  private readonly byEmail = new Map<string, AccountIdentity | null>();

  constructor(
    private readonly env: UserIdentityEnv,
    deps: UserIdentityDeps = {},
  ) {
    this.deps = {
      userDAO: () => Promise.resolve(new UserDAO(env.DB)),
      userEmailDAO: () => Promise.resolve(new UserEmailDAO(env.DB)),
      ...deps,
    };
  }

  private static invalid(): AccountIdentity | null {
    return null;
  }

  /**
   * Resolve a sign-in address to its account, or null when unknown.
   *
   * Only a verified address resolves. A revoked address (changed away from) is
   * retained for attribution but must never authenticate, otherwise a
   * reassigned company address would inherit the previous holder's account.
   */
  public async resolveAccount(email: string): Promise<AccountIdentity | null> {
    const key = normalize(email);
    if (!isValidEmailFormat(key)) return null;
    if (this.byEmail.has(key)) return this.byEmail.get(key) ?? null;
    const resolved = await this.load(key);
    this.byEmail.set(key, resolved);
    return resolved;
  }

  /**
  Account id for a sign-in address, or null when unknown.
  */
  public async resolveUserId(email: string): Promise<string | null> {
    const account = await this.resolveAccount(email);
    return account?.id ?? null;
  }

  /**
   * Account behind an id. The inverse direction, for callers that already hold
   * a stable key (a token, a repository owner) and need the current address.
   */
  public async resolveUserById(userId: string): Promise<{ id: string; email: string } | null> {
    try {
      const dao = await this.deps.userDAO();
      const row = await dao.getById(userId);
      if (!row?.id) return null;
      return { id: row.id, email: normalize(row.current_email ?? row.email) };
    } catch (error) {
      throw error instanceof DatabaseError
        ? error
        : new DatabaseError(`Failed to resolve account: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async load(email: string): Promise<AccountIdentity | null> {
    let emailDAO: UserEmailDAO;
    let userDAO: UserDAO;
    try {
      [emailDAO, userDAO] = await Promise.all([this.deps.userEmailDAO(), this.deps.userDAO()]);
    } catch (error) {
      throw error instanceof DatabaseError
        ? error
        : new DatabaseError(`Failed to load identity: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A known address is authoritative, and a *revoked* one must not resolve:
    // falling through to a `users` lookup would let a reassigned address keep
    // authenticating the previous holder's account.
    const registered = await emailDAO.get(email).catch(() => null);
    if (registered) {
      if (registered.is_verified !== 1) return UserIdentityService.invalid();
      const row = await userDAO.getById(registered.user_id).catch(() => null);
      if (!row?.id) return UserIdentityService.invalid();
      return {
        id: row.id,
        email: normalize(row.current_email ?? row.email),
        anchorEmail: row.email,
        username: row.username ?? null,
      };
    }
    // No registry row. Migration 0028 backfilled a verified row for every
    // anchor, so a row-less address is either brand new or on a pre-0028
    // database where the address is the anchor; both are covered by the
    // `users` lookups. A *revoked* address always has a row and returns above.
    const byCurrent = typeof userDAO.getByCurrentEmail === 'function' ? await userDAO.getByCurrentEmail(email).catch(() => null) : null;
    const legacy = byCurrent ?? (await userDAO.getByEmail(email).catch(() => null));
    if (!legacy?.id) return UserIdentityService.invalid();
    return {
      id: legacy.id,
      email: normalize(legacy.current_email ?? legacy.email),
      anchorEmail: legacy.email,
      username: legacy.username ?? null,
    };
  }

  /**
  Every address known for an account, verified ones first.
  */
  public async listAddresses(userId: string): Promise<Array<{ email: string; isVerified: boolean }>> {
    const dao = await this.deps.userEmailDAO();
    const rows = await dao.listByUserId(userId);
    return rows.map((row) => ({ email: row.email, isVerified: row.is_verified === 1 }));
  }

  /**
   * Point an account at a new sign-in address.
   *
   * The account id, the frozen anchor, and every id-keyed grant are untouched:
   * only which address authenticates the account moves. The previous address is
   * revoked rather than deleted, so rows written before the change still
   * resolve to this account, and it is released for a later legitimate holder.
   *
   * Rejects an address that is already verified for another account. That check
   * is the whole reason this method is not simply a `UPDATE`: Cloudflare Access
   * is the only authenticator, so an unverified self-service change would let
   * anyone claim an address and inherit its account.
   *
   * No route exposes this yet — proof of control for the new address (a
   * confirm step performed while authenticated as that address) has to land
   * first.
   */
  public async setPrimaryEmail(userId: string, newEmail: string, now = TimestampUtil.getCurrentUnixTimestampInSeconds()): Promise<AccountIdentity> {
    const email = normalize(newEmail);
    if (!isValidEmailFormat(email)) throw new BadRequestError('Invalid email address');
    const userDAO = await this.deps.userDAO();
    const emailDAO = await this.deps.userEmailDAO();
    const row = await userDAO.getById(userId);
    if (!row?.id) throw new BadRequestError('User not found');
    const current = normalize(row.current_email ?? row.email);
    if (current === email) {
      return { id: row.id, email, anchorEmail: row.email, username: row.username ?? null };
    }
    const holder = await emailDAO.resolveVerified(email);
    if (holder && holder.user_id !== row.id) throw new ConflictError('Email is already in use');
    await emailDAO.register({ email, userId: row.id, isVerified: true, now });
    // Revoke every other verified address, so only the new one authenticates.
    await emailDAO.revokeAllVerified(row.id, email);
    await userDAO.setCurrentEmail(row.id, email, now);
    this.byEmail.delete(current);
    this.byEmail.set(email, { id: row.id, email, anchorEmail: row.email, username: row.username ?? null });
    return { id: row.id, email, anchorEmail: row.email, username: row.username ?? null };
  }

  /**
   * Ops/migration path: attach an address that has already been proven, without
   * making it the sign-in address.
   */
  public async linkVerifiedEmail(userId: string, email: string, now = TimestampUtil.getCurrentUnixTimestampInSeconds()): Promise<void> {
    const address = normalize(email);
    if (!isValidEmailFormat(address)) throw new BadRequestError('Invalid email address');
    const dao = await this.deps.userEmailDAO();
    const outcome = await dao.register({ email: address, userId, isVerified: true, now });
    if (outcome === 'already-claimed') throw new ConflictError('Email is already in use');
  }
}

export { UserIdentityService };
export type { AccountIdentity, UserIdentityDeps, UserIdentityEnv };
