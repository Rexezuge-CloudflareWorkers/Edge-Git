import {
  EventDAO,
  IssueDAO,
  NamespaceDAO,
  NotificationDAO,
  OrganizationDAO,
  PullRequestDAO,
  RepositoryDAO,
  UserDAO,
  UserEmailDAO,
  WebhookDAO,
} from '@edge-git/backend-data/dao';
import type { UserRow } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError, NotFoundError } from '@edge-git/backend-errors';
import { isReservedNamespaceName } from '@edge-git/shared/constants';
import { TimestampUtil } from '@edge-git/shared/utils';
import { cascadeOwnerRepos } from '../repo/repoRenameCascade';
import { UserIdentityService } from '../identity/UserIdentityService';
import { registerAccount, resolveAccount, resolveUserId } from './accountLookup';
import type { AccountLookupDeps, AccountSummary } from './accountLookup';

interface UserServiceEnv {
  DB: D1Queryable;
}

interface UserServiceDeps {
  userDAO?: () => Promise<UserDAO>;
  userEmailDAO?: () => Promise<UserEmailDAO>;
  userIdentity?: () => Promise<UserIdentityService>;
  namespaceDAO?: () => Promise<NamespaceDAO>;
  organizationDAO?: () => Promise<OrganizationDAO>;
  repositoryDAO?: () => Promise<RepositoryDAO>;
  issueDAO?: () => Promise<IssueDAO>;
  pullRequestDAO?: () => Promise<PullRequestDAO>;
  eventDAO?: () => Promise<EventDAO>;
  notificationDAO?: () => Promise<NotificationDAO>;
  webhookDAO?: () => Promise<WebhookDAO>;
}

const USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;

function deriveUsernameCandidate(email: string): string {
  const prefix = email.split('@', 1)[0].toLowerCase();
  let sanitized = '';
  for (const ch of prefix) {
    sanitized += ch === '-' || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') ? ch : '-';
  }
  sanitized = sanitized.replaceAll(/-{2,}/g, '-');
  let start = 0;
  while (start < sanitized.length && sanitized[start] === '-') start += 1;
  let end = sanitized.length;
  while (end > start && sanitized[end - 1] === '-') end -= 1;
  sanitized = sanitized.slice(start, end);
  if (USERNAME_RE.test(sanitized)) return sanitized;
  let alnum = '';
  for (const ch of sanitized) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) alnum += ch;
  }
  if (alnum.length > 0) return alnum.slice(0, 39);
  return 'user';
}

class UserService {
  private readonly deps: Required<UserServiceDeps>;

  constructor(
    private readonly env: UserServiceEnv,
    deps: UserServiceDeps = {},
  ) {
    this.deps = {
      userDAO: () => Promise.resolve(new UserDAO(env.DB)),
      userEmailDAO: () => Promise.resolve(new UserEmailDAO(env.DB)),
      userIdentity: () => Promise.resolve(new UserIdentityService(env)),
      namespaceDAO: () => Promise.resolve(new NamespaceDAO(env.DB)),
      organizationDAO: () => Promise.resolve(new OrganizationDAO(env.DB)),
      repositoryDAO: () => Promise.resolve(new RepositoryDAO(env.DB)),
      issueDAO: () => Promise.resolve(new IssueDAO(env.DB)),
      pullRequestDAO: () => Promise.resolve(new PullRequestDAO(env.DB)),
      eventDAO: () => Promise.resolve(new EventDAO(env.DB)),
      notificationDAO: () => Promise.resolve(new NotificationDAO(env.DB)),
      webhookDAO: () =>
        Promise.reject<WebhookDAO>(new Error('UserService requires an injected webhookDAO outside request scope.')),
      ...deps,
    };
  }

  public static validateUsername(username: string): void {
    if (!USERNAME_RE.test(username)) {
      throw new BadRequestError('Invalid username');
    }
    if (isReservedNamespaceName(username)) {
      throw new BadRequestError('Username is reserved');
    }
  }

  /**
   * Resolve the authenticated address to an account, registering one if the
   * address is unknown.
   *
   * Resolution goes through the address registry rather than `users.email`, so
   * a person who changes their address keeps the same account (and therefore
   * their repositories, grants, and tokens) instead of acquiring a second,
   * empty one. An address that is already verified for an account always
   * resolves to that account, so registration can never fork an identity.
   */
  public async upsertUser(email: string): Promise<AccountSummary> {
    const normalized = email.toLowerCase();
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const dao = await this.deps.userDAO();
    let account = await resolveAccount(this.lookupDeps(), normalized);
    if (!account) {
      // Prefer the address as the frozen anchor (what pre-0028 rows look like);
      // fall back to an opaque one only when the address is already held as
      // another account's anchor, so a released address stays re-claimable.
      account = await registerAccount(this.lookupDeps(), normalized, normalized, now);
      if (!account) account = await registerAccount(this.lookupDeps(), normalized, UserDAO.newAnchor(), now);
    }
    // Best-effort username bootstrap: an account that exists but has no handle
    // yet still gets one.
    try {
      if (account?.username) return { id: account.id, email: account.email, username: account.username };
      const base = deriveUsernameCandidate(normalized);
      const handle = await this.findFreeUsername(base);
      await dao.ensureUsername(account?.id || normalized, handle, now);
      try {
        const ns = await this.deps.namespaceDAO();
        await ns.claimIgnore({ usernameCi: handle.toLowerCase(), kind: 'user', userEmail: normalized, now });
      } catch {
        // namespaces table may not exist on old DBs — username column is authoritative there
      }
      return { id: account?.id ?? '', email: normalized, username: handle };
    } catch {
      // Never fail authentication because of profile bootstrap.
      return account ? { id: account.id, email: account.email, username: account.username } : { id: '', email: normalized, username: null };
    }
  }

  /**
   * Account id for an address, or null when unknown. Write paths use this to
   * stamp `user_id` alongside the legacy address column, which is what lets a
   * grant, repository, or token survive an address change.
   */
  public async resolveUserId(email: string): Promise<string | null> {
    return resolveUserId(this.lookupDeps(), email);
  }

  private lookupDeps(): AccountLookupDeps {
    return { userDAO: this.deps.userDAO, userEmailDAO: this.deps.userEmailDAO };
  }

  private async findFreeUsername(base: string): Promise<string> {
    const dao = await this.deps.userDAO();
    let candidate = base;
    for (let attempt = 0; attempt < 50; attempt++) {
      const ci = candidate.toLowerCase();
      let taken = isReservedNamespaceName(ci);
      try {
        const ns = await this.deps.namespaceDAO();
        taken ||= await ns.isTaken(ci);
      } catch {
        // keep reserved-derived taken value
      }
      if (!taken) {
        try {
          const [userMatch, orgMatch] = await Promise.all([
            dao.getByUsernameCi(ci),
            this.deps.organizationDAO().then((o) => o.getByUsernameCi(ci)),
          ]);
          taken = Boolean(userMatch ?? orgMatch);
        } catch {
          // ignore — registry check above stands
        }
      }
      if (!taken) return candidate;
      candidate = `${base}-${attempt + 1}`;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  /**
   * Profile for an address. Accepts either the current sign-in address or the
   * frozen anchor, and always reports the *current* address so a caller never
   * sees the internal anchor.
   */
  public async getProfileByEmail(email: string): Promise<{ email: string; username: string | null }> {
    const normalized = email.toLowerCase();
    const dao = await this.deps.userDAO();
    const byCurrent =
      typeof dao.getByCurrentEmail === 'function' ? await dao.getByCurrentEmail(normalized).catch(() => null) : null;
    const row = byCurrent ?? (await dao.getByEmail(normalized).catch(() => null));
    if (!row) throw new NotFoundError('User not found');
    return { email: (row.current_email ?? row.email).toLowerCase(), username: row.username ?? null };
  }

  public async getByUsername(username: string): Promise<UserRow | null> {
    const dao = await this.deps.userDAO();
    try {
      return await dao.getByUsernameCi(username.toLowerCase());
    } catch {
      return null;
    }
  }

  public async renameUsername(email: string, newUsername: string): Promise<{ email: string; username: string }> {
    const handle = newUsername.trim();
    UserService.validateUsername(handle);
    const handleCi = handle.toLowerCase();
    const normalized = email.toLowerCase();
    const dao = await this.deps.userDAO();
    // Resolve through the account, not the address: the caller passes whichever
    // address currently authenticates, and the account is the same either way.
    const account = await resolveAccount(this.lookupDeps(), normalized);
    if (!account) throw new NotFoundError('User not found');
    const existing = account.id ? await dao.getById(account.id) : await dao.getByEmail(normalized);
    if (!existing) throw new NotFoundError('User not found');
    if (existing.username?.toLowerCase() === handleCi) {
      return { email: (existing.current_email ?? existing.email).toLowerCase(), username: existing.username };
    }
    // Stable reference for "is this row mine" checks: the account id when
    // available, else the address for databases without one.
    const selfRef = existing.id ?? normalized;
    const ownsNamespaceRow = (row: { user_id?: string | null; user_email?: string | null }): boolean => {
      if (row.user_id) return row.user_id === selfRef;
      return row.user_email?.toLowerCase() === normalized;
    };
    let taken = false;
    try {
      const nsDao = await this.deps.namespaceDAO();
      let selfOwned = false;
      let otherOwned = false;
      try {
        if (typeof nsDao.get === 'function') {
          const row = await nsDao.get(handleCi);
          if (row) {
            if (row.kind === 'user' && ownsNamespaceRow(row)) {
              selfOwned = true;
            } else {
              otherOwned = true;
            }
          }
        }
      } catch {
        // get failed (legacy DB) — fall through to isTaken below.
      }
      if (otherOwned) {
        taken = true;
      } else if (!selfOwned) {
        try {
          taken = await nsDao.isTaken(handleCi);
        } catch {
          taken = false;
        }
      }
      // selfOwned → taken stays false so the owner can reclaim a
      // previously renamed-away handle; the users/orgs check below still
      // blocks if another account actively holds the handle.
    } catch {
      taken = false;
    }
    if (!taken) {
      try {
        const orgDao = await this.deps.organizationDAO();
        const [userMatch, orgMatch] = await Promise.all([dao.getByUsernameCi(handleCi), orgDao.getByUsernameCi(handleCi)]);
        // Compare accounts, not addresses: a rename target held by the same
        // account is a reclaim, whatever address that account signs in with.
        const userTaken = Boolean(userMatch && (userMatch.id ?? userMatch.email.toLowerCase()) !== selfRef);
        taken = Boolean(userTaken || orgMatch);
      } catch {
        // ignore
      }
    }
    if (taken) throw new BadRequestError('Username is already taken');
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const oldCi = existing.username?.toLowerCase();
    // Claim-first ordering narrows the rename TOCTOU: claim the new name
    // before mutating `users`, so a concurrent claimer wins with a clean
    // abort instead of leaving `users.username` renamed without a namespace.
    // If the subsequent update fails, best-effort release the new claim.
    // Legacy DBs without a namespaces table fall back to `users.username`
    // as authoritative (claim/isTaken both throw there).
    let namespaceClaimed = false;
    let legacyNamespaces = false;
    let claimedFresh = false;
    try {
      const ns = await this.deps.namespaceDAO();
      await ns.claim({ usernameCi: handleCi, kind: 'user', userEmail: normalized, now });
      namespaceClaimed = true;
      claimedFresh = true;
    } catch (error) {
      // Claim race or legacy-DB error: if the existing claim belongs to self
      // (rename-back after a failed DO move), treat as success so rollback
      // never orphans the user. Otherwise report taken cleanly.
      try {
        const nsDao = await this.deps.namespaceDAO();
        const row = await nsDao.get(handleCi).catch(() => null);
        if (row && ownsNamespaceRow(row)) {
          namespaceClaimed = true;
          claimedFresh = false;
        } else {
          if (await nsDao.isTaken(handleCi)) throw new BadRequestError('Username is already taken');
        }
      } catch (inner) {
        if (inner instanceof BadRequestError) throw inner;
        // isTaken itself threw → namespaces table missing → legacy path.
        legacyNamespaces = true;
      }
      if (!legacyNamespaces && !namespaceClaimed) throw error instanceof Error ? error : new BadRequestError('Username is already taken');
    }
    try {
      await dao.setUsername(selfRef, handle, now);
    } catch (error) {
      if (claimedFresh) {
        try {
          const ns = await this.deps.namespaceDAO();
          await ns.release(handleCi);
        } catch {
          // ignore rollback failure
        }
      }
      throw error;
    }
    // Hardening: old names stay reserved (no immediate release) so a
    // concurrent attacker cannot hijack the freed handle in the window
    // between D1 rename and DO move. Renamed-away handles remain taken
    // for other accounts, but the owning email may reclaim them (rename
    // back / rollback after a failed DO move). A future tombstone/GC
    // migration can free them after a grace period.
    // Simple rename: cascade owner on user-owned repos. Display names are
    // computed from `repositories`, so no sidecar updates are needed.
    if (oldCi) {
      try {
        await cascadeOwnerRepos(
          { repositoryDAO: this.deps.repositoryDAO },
          { oldOwnerCi: oldCi, newOwner: handle, now },
        );
      } catch {
        // ignore
      }
    }
    return { email: (existing.current_email ?? existing.email).toLowerCase(), username: handle };
  }
}

export { UserService };
export type { UserServiceDeps, UserServiceEnv };
