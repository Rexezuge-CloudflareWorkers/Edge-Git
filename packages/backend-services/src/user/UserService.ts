import {
  EventDAO,
  IssueDAO,
  NamespaceDAO,
  NotificationDAO,
  OrganizationDAO,
  PullRequestDAO,
  RepositoryDAO,
  UserDAO,
  WebhookDAO,
} from '@edge-git/backend-data/dao';
import type { UserRow } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError, NotFoundError } from '@edge-git/backend-errors';
import { isReservedNamespaceName } from '@edge-git/shared/constants';
import { TimestampUtil } from '@edge-git/shared/utils';
import { cascadeOwnerRepos } from '../repo/repoRenameCascade';

interface UserServiceEnv {
  DB: D1Queryable;
}

interface UserServiceDeps {
  userDAO?: () => Promise<UserDAO>;
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
      namespaceDAO: () => Promise.resolve(new NamespaceDAO(env.DB)),
      organizationDAO: () => Promise.resolve(new OrganizationDAO(env.DB)),
      repositoryDAO: () => Promise.resolve(new RepositoryDAO(env.DB)),
      issueDAO: () => Promise.resolve(new IssueDAO(env.DB)),
      pullRequestDAO: () => Promise.resolve(new PullRequestDAO(env.DB)),
      eventDAO: () => Promise.resolve(new EventDAO(env.DB)),
      notificationDAO: () => Promise.resolve(new NotificationDAO(env.DB)),
      webhookDAO: () => Promise.resolve(new WebhookDAO(env.DB)),
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

  public async upsertUser(email: string): Promise<void> {
    const normalized = email.toLowerCase();
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const dao = await this.deps.userDAO();
    await dao.upsertUser(normalized, now);
    // Best-effort username bootstrap: existing rows keep their handle.
    try {
      const existing = await dao.getByEmail(normalized);
      if (existing?.username) return;
      const base = deriveUsernameCandidate(normalized);
      const handle = await this.findFreeUsername(base);
      await dao.ensureUsername(normalized, handle, now);
      try {
        const ns = await this.deps.namespaceDAO();
        await ns.claimIgnore({ usernameCi: handle.toLowerCase(), kind: 'user', userEmail: normalized, now });
      } catch {
        // namespaces table may not exist on old DBs — username column is authoritative there
      }
    } catch {
      // Never fail authentication because of profile bootstrap.
    }
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

  public async getProfileByEmail(email: string): Promise<{ email: string; username: string | null }> {
    const dao = await this.deps.userDAO();
    const row = await dao.getByEmail(email.toLowerCase());
    if (!row) throw new NotFoundError('User not found');
    return { email: row.email, username: row.username ?? null };
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
    const existing = await dao.getByEmail(normalized);
    if (!existing) throw new NotFoundError('User not found');
    if (existing.username?.toLowerCase() === handleCi) return { email: existing.email, username: existing.username };
    let taken = false;
    try {
      const nsDao = await this.deps.namespaceDAO();
      taken = await nsDao.isTaken(handleCi);
    } catch {
      taken = false;
    }
    if (!taken) {
      try {
        const orgDao = await this.deps.organizationDAO();
        const [userMatch, orgMatch] = await Promise.all([dao.getByUsernameCi(handleCi), orgDao.getByUsernameCi(handleCi)]);
        taken = Boolean(userMatch ?? orgMatch);
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
    try {
      const ns = await this.deps.namespaceDAO();
      await ns.claim({ usernameCi: handleCi, kind: 'user', userEmail: normalized, now });
      namespaceClaimed = true;
    } catch (error) {
      // Claim race or legacy-DB error: check once more to report taken cleanly.
      try {
        const nsDao = await this.deps.namespaceDAO();
        if (await nsDao.isTaken(handleCi)) throw new BadRequestError('Username is already taken');
      } catch (inner) {
        if (inner instanceof BadRequestError) throw inner;
        // isTaken itself threw → namespaces table missing → legacy path.
        legacyNamespaces = true;
      }
      if (!legacyNamespaces) throw error instanceof Error ? error : new BadRequestError('Username is already taken');
    }
    try {
      await dao.setUsername(normalized, handle, now);
    } catch (error) {
      if (namespaceClaimed) {
        try {
          const ns = await this.deps.namespaceDAO();
          await ns.release(handleCi);
        } catch {
          // ignore rollback failure
        }
      }
      throw error;
    }
    try {
      const ns = await this.deps.namespaceDAO();
      if (oldCi) {
        try {
          await ns.release(oldCi);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore — users.username is source of truth on legacy DBs
    }
    // Simple rename: cascade owner on user-owned repos (plus denormalized
    // `full_name` sidecars), free the old name immediately.
    if (oldCi) {
      try {
        await cascadeOwnerRepos(
          {
            repositoryDAO: this.deps.repositoryDAO,
            issueDAO: this.deps.issueDAO,
            pullRequestDAO: this.deps.pullRequestDAO,
            eventDAO: this.deps.eventDAO,
            notificationDAO: this.deps.notificationDAO,
            webhookDAO: this.deps.webhookDAO,
          },
          { oldOwnerCi: oldCi, newOwner: handle, now },
        );
      } catch {
        // ignore
      }
    }
    return { email: normalized, username: handle };
  }
}

export { UserService };
export type { UserServiceDeps, UserServiceEnv };
