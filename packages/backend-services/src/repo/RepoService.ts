import {
  BranchProtectionDAO,
  EventDAO,
  IssueDAO,
  NamespaceDAO,
  NotificationDAO,
  OrganizationDAO,
  OrganizationMemberDAO,
  PullRequestDAO,
  PullThreadDAO,
  ReleaseDAO,
  RepoCollaboratorDAO,
  RepositoryDAO,
  StarDAO,
  UserDAO,
  WatchDAO,
} from '@edge-git/backend-data/dao';
import type { RepositoryRow, RepoRole } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError, ForbiddenError, NotFoundError } from '@edge-git/backend-errors';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { isReservedNamespaceName } from '@edge-git/shared/constants';
import { TimestampUtil, UUIDUtil } from '@edge-git/shared/utils';
import { PermissionService } from '../permission/PermissionService';

interface RepoServiceEnv {
  DB: D1Queryable;
  MAX_REPOS_PER_USER?: string;
}

const OWNER_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const REPO_RE = /^[\w.-]{1,100}$/i;

interface RepoServiceDeps {
  repositoryDAO?: () => Promise<RepositoryDAO>;
  issueDAO?: () => Promise<IssueDAO>;
  pullRequestDAO?: () => Promise<PullRequestDAO>;
  pullThreadDAO?: () => Promise<PullThreadDAO>;
  branchProtectionDAO?: () => Promise<BranchProtectionDAO>;
  userDAO?: () => Promise<UserDAO>;
  organizationDAO?: () => Promise<OrganizationDAO>;
  organizationMemberDAO?: () => Promise<OrganizationMemberDAO>;
  repoCollaboratorDAO?: () => Promise<RepoCollaboratorDAO>;
  namespaceDAO?: () => Promise<NamespaceDAO>;
  starDAO?: () => Promise<StarDAO>;
  watchDAO?: () => Promise<WatchDAO>;
  eventDAO?: () => Promise<EventDAO>;
  notificationDAO?: () => Promise<NotificationDAO>;
  releaseDAO?: () => Promise<ReleaseDAO>;
}

class RepoService {
  private readonly deps: Required<RepoServiceDeps>;

  constructor(
    private readonly env: RepoServiceEnv,
    deps: RepoServiceDeps = {},
  ) {
    this.deps = {
      repositoryDAO: () => Promise.resolve(new RepositoryDAO(env.DB)),
      issueDAO: () => Promise.resolve(new IssueDAO(env.DB)),
      pullRequestDAO: () => Promise.resolve(new PullRequestDAO(env.DB)),
      pullThreadDAO: () => Promise.resolve(new PullThreadDAO(env.DB)),
      branchProtectionDAO: () => Promise.resolve(new BranchProtectionDAO(env.DB)),
      userDAO: () => Promise.resolve(new UserDAO(env.DB)),
      organizationDAO: () => Promise.resolve(new OrganizationDAO(env.DB)),
      organizationMemberDAO: () => Promise.resolve(new OrganizationMemberDAO(env.DB)),
      repoCollaboratorDAO: () => Promise.resolve(new RepoCollaboratorDAO(env.DB)),
      namespaceDAO: () => Promise.resolve(new NamespaceDAO(env.DB)),
      starDAO: () => Promise.resolve(new StarDAO(env.DB)),
      watchDAO: () => Promise.resolve(new WatchDAO(env.DB)),
      eventDAO: () => Promise.resolve(new EventDAO(env.DB)),
      notificationDAO: () => Promise.resolve(new NotificationDAO(env.DB)),
      releaseDAO: () => Promise.resolve(new ReleaseDAO(env.DB)),
      ...deps,
    };
  }

  public static normalizeOwner(owner: string): string {
    return owner.trim();
  }

  public static normalizeRepo(name: string): string {
    const n = name.trim();
    return n.endsWith('.git') ? n.slice(0, -4) : n;
  }

  public static validateNames(owner: string, name: string): void {
    if (!OWNER_RE.test(owner) || !REPO_RE.test(name)) {
      throw new BadRequestError('Invalid owner or repository name');
    }
    if (isReservedNamespaceName(owner)) {
      throw new BadRequestError('Username is reserved');
    }
  }

  private permissionService(): PermissionService {
    return new PermissionService(this.env, {
      organizationDAO: this.deps.organizationDAO,
      organizationMemberDAO: this.deps.organizationMemberDAO,
      repoCollaboratorDAO: this.deps.repoCollaboratorDAO,
      namespaceDAO: this.deps.namespaceDAO,
    });
  }

  public async getRole(viewerEmail: string | null, repo: RepositoryRow | null): Promise<RepoRole | null> {
    return this.permissionService().getRole(viewerEmail, repo);
  }

  private async resolveCallerUsernameCi(userEmail: string): Promise<string | null> {
    try {
      const userDao = await this.deps.userDAO();
      const user = await userDao.getByEmail(userEmail.toLowerCase());
      if (user?.username) return user.username.toLowerCase();
    } catch {
      // ignore — fall back to email prefix below
    }
    const prefix = userEmail.split('@', 1)[0].toLowerCase();
    return prefix || null;
  }

  public async createRepo(
    userEmail: string,
    owner: string,
    name: string,
    description: string | null,
    isPrivate: boolean,
    opts: { forkedFromRepoId?: string | null; forkedFromFullName?: string | null } = {},
  ): Promise<{ id: string }> {
    const normalizedOwner = RepoService.normalizeOwner(owner);
    const dao = await this.deps.repositoryDAO();
    RepoService.validateNames(normalizedOwner, name);
    const existing = await dao.getByOwnerAndName(normalizedOwner, name);
    if (existing) {
      throw new BadRequestError('Repository already exists');
    }
    const owned = await dao.listByOwnerEmail(userEmail, 1000).catch(() => []);
    const max = ConfigurationManager.repo.getMaxPerUser(this.env);
    if (owned.length >= max) {
      throw new BadRequestError(`Maximum ${max} repositories per user`);
    }

    const ownerCi = normalizedOwner.toLowerCase();
    const callerCi = await this.resolveCallerUsernameCi(userEmail);
    const callerEmail = userEmail.toLowerCase();
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const id = UUIDUtil.getRandomUUID();

    // Self-owned fast path (covers legacy fakes with no users/orgs tables).
    if (callerCi && ownerCi === callerCi) {
      await dao.create({ id, ownerEmail: callerEmail, owner: normalizedOwner, name, description, isPrivate, now, ownerType: 'user', ownerUserEmail: callerEmail, forkedFromRepoId: opts.forkedFromRepoId ?? null, forkedFromFullName: opts.forkedFromFullName ?? null });
      return { id };
    }

    // Org-owned path: org must exist and caller must be owner or member (both may create).
    let org: { id: string; username: string } | null = null;
    try {
      const orgDao = await this.deps.organizationDAO();
      org = await orgDao.getByUsernameCi(ownerCi);
    } catch {
      org = null;
    }
    if (org) {
      let membership: { role: string } | null = null;
      try {
        const memberDao = await this.deps.organizationMemberDAO();
        membership = await memberDao.get(org.id, callerEmail);
      } catch {
        membership = null;
      }
      if (!membership) {
        throw new ForbiddenError('Only organization members can create repositories for this organization');
      }
      await dao.create({
        id,
        ownerEmail: callerEmail,
        owner: org.username,
        name,
        description,
        isPrivate,
        now,
        ownerType: 'org',
        orgId: org.id,
        forkedFromRepoId: opts.forkedFromRepoId ?? null,
        forkedFromFullName: opts.forkedFromFullName ?? null,
      });
      return { id };
    }

    // Legacy fallback: unknown owner that is not the caller and not an org.
    // Preserve old behavior for fakes (owner free-form) but guard hijack on real DBs:
    // if a namespace exists for another user/org, refuse.
    try {
      const nsDao = await this.deps.namespaceDAO();
      const ns = await nsDao.get(ownerCi);
      if (ns?.user_email && ns.user_email.toLowerCase() !== callerEmail) {
        throw new ForbiddenError('Only the repository owner can perform this action');
      }
    } catch (error) {
      if (error instanceof ForbiddenError) throw error;
      // missing namespaces table → allow legacy free-form owner
    }
    await dao.create({ id, ownerEmail: callerEmail, owner: normalizedOwner, name, description, isPrivate, now, ownerType: 'user', ownerUserEmail: callerEmail, forkedFromRepoId: opts.forkedFromRepoId ?? null, forkedFromFullName: opts.forkedFromFullName ?? null });
    return { id };
  }

  public async getRepo(owner: string, name: string): Promise<RepositoryRow | null> {
    const dao = await this.deps.repositoryDAO();
    return dao.getByOwnerAndName(owner, name);
  }

  public async getByOwnerAndName(owner: string, name: string): Promise<RepositoryRow | null> {
    return this.getRepo(owner, name);
  }

  public async getById(id: string): Promise<RepositoryRow | null> {
    const dao = await this.deps.repositoryDAO();
    return dao.getById(id);
  }

  public async listByOwnerEmail(ownerEmail: string, limit = 100): Promise<RepositoryRow[]> {
    const dao = await this.deps.repositoryDAO();
    return dao.listByOwnerEmail(ownerEmail, limit);
  }

  public async listVisibleForUser(userEmail: string, limit = 100): Promise<RepositoryRow[]> {
    const dao = await this.deps.repositoryDAO();
    const seen = new Map<string, RepositoryRow>();
    const pushAll = (rows: RepositoryRow[]): void => {
      for (const row of rows) {
        if (!seen.has(row.id)) seen.set(row.id, row);
      }
    };
    pushAll(await dao.listByOwnerEmail(userEmail, limit).catch(() => []));
    try {
      const usernameCi = await this.resolveCallerUsernameCi(userEmail);
      if (usernameCi) {
        // Username-indexed listing catches renames where owner_email stayed stale.
        const byOwner = await dao.listByOwner(usernameCi, limit).catch(() => []);
        pushAll(byOwner);
      }
    } catch {
      // ignore
    }
    // Org repos where the user is a member/owner.
    try {
      const memberDAO = await this.deps.organizationMemberDAO();
      const orgDao = await this.deps.organizationDAO();
      const memberships = await memberDAO.listOrgsByUser(userEmail).catch(() => []);
      for (const m of memberships.slice(0, 50)) {
        const rows = await dao.listByOrgId(m.org_id, limit).catch(() => []);
        pushAll(rows);
        // Legacy org repos without org_id backfill: include by owner username.
        try {
          const org = await orgDao.getById(m.org_id);
          if (org) pushAll(await dao.listByOwner(org.username, limit).catch(() => []));
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    // Explicit collaborator grants.
    try {
      const collabDAO = await this.deps.repoCollaboratorDAO();
      const grants = await collabDAO.listByUser(userEmail, 500).catch(() => []);
      for (const g of grants.slice(0, 200)) {
        const repo = await dao.getById(g.repo_id).catch(() => null);
        if (repo) pushAll([repo]);
      }
    } catch {
      // ignore
    }
    // Filter to actually-visible (drops private org repos the member cannot see).
    const visible: RepositoryRow[] = [];
    for (const repo of seen.values()) {
      const role = await this.getRole(userEmail, repo).catch(() => null);
      if (role) visible.push(repo);
    }
    visible.sort((a, b) => b.updated_at - a.updated_at);
    return visible.slice(0, limit);
  }

  public async requireRole(
    owner: string,
    name: string,
    viewerEmail: string | null,
    minimum: RepoRole,
  ): Promise<{ repo: RepositoryRow; role: RepoRole }> {
    const dao = await this.deps.repositoryDAO();
    const repo = await dao.getByOwnerAndName(owner, name);
    if (!repo) throw new NotFoundError('Repository not found');
    const role = await this.getRole(viewerEmail, repo);
    if (!role) {
      // Private repos hide existence; public repos report forbidden for write/admin needs.
      if (repo.is_private === 1) throw new NotFoundError('Repository not found');
      throw new ForbiddenError('Only the repository owner can perform this action');
    }
    if (!PermissionService.meets(role, minimum)) {
      throw new ForbiddenError('Only the repository owner can perform this action');
    }
    return { repo, role };
  }

  public async requireOwner(owner: string, name: string, userEmail: string): Promise<RepositoryRow> {
    const { repo } = await this.requireRole(owner, name, userEmail, 'admin');
    return repo;
  }

  public async updateRepo(
    owner: string,
    name: string,
    userEmail: string,
    patch: { description?: string | null; isPrivate?: boolean },
  ): Promise<RepositoryRow> {
    const repo = await this.requireOwner(owner, name, userEmail);
    if (typeof patch.description === 'string' && patch.description.length > 500) {
      throw new BadRequestError('Description must be 500 characters or fewer');
    }
    if (patch.isPrivate !== undefined && typeof patch.isPrivate !== 'boolean') {
      throw new BadRequestError('isPrivate must be a boolean');
    }
    const dao = await this.deps.repositoryDAO();
    await dao.update(repo.id, { description: patch.description, isPrivate: patch.isPrivate, now: TimestampUtil.getCurrentUnixTimestampInSeconds() });
    const updated = await dao.getById(repo.id);
    if (!updated) {
      throw new NotFoundError('Repository not found');
    }
    return updated;
  }

  public async deleteRepo(owner: string, name: string, userEmail: string): Promise<{ id: string }> {
    const repo = await this.requireOwner(owner, name, userEmail);
    const issueDAO = await this.deps.issueDAO();
    await issueDAO.deleteByRepo(repo.id);
    try {
      const pullRequestDAO = await this.deps.pullRequestDAO();
      await pullRequestDAO.deleteByRepo(repo.id);
    } catch {
      // ignore — legacy DBs without pull_requests tables
    }
    try {
      const pullThreadDAO = await this.deps.pullThreadDAO();
      await pullThreadDAO.deleteByRepo(repo.id);
    } catch {
      // ignore — legacy DBs without pull_review_threads tables
    }
    try {
      const protectionDAO = await this.deps.branchProtectionDAO();
      await protectionDAO.deleteByRepo(repo.id);
    } catch {
      // ignore — legacy DBs without branch_protection_rules table
    }
    try {
      const collabDao = await this.deps.repoCollaboratorDAO();
      await collabDao.deleteByRepo(repo.id);
    } catch {
      // ignore — legacy DBs without collaborators table
    }
    try {
      const starDao = await this.deps.starDAO();
      await starDao.deleteByRepo(repo.id);
    } catch {
      // ignore — legacy DBs without repo_stars table
    }
    try {
      const watchDao = await this.deps.watchDAO();
      await watchDao.deleteByRepo(repo.id);
    } catch {
      // ignore — legacy DBs without repo_watches table
    }
    try {
      const eventDao = await this.deps.eventDAO();
      await eventDao.deleteByRepo(repo.id);
    } catch {
      // ignore — legacy DBs without repo_events table
    }
    try {
      const notificationDao = await this.deps.notificationDAO();
      await notificationDao.deleteByRepo(repo.id);
    } catch {
      // ignore — legacy DBs without notifications table
    }
    try {
      const releaseDao = await this.deps.releaseDAO();
      await releaseDao.deleteByRepo(repo.id);
    } catch {
      // ignore — legacy DBs without releases tables
    }
    const repositoryDAO = await this.deps.repositoryDAO();
    await repositoryDAO.deleteById(repo.id);
    return { id: repo.id };
  }
}

export { RepoService };
export type { RepoServiceDeps, RepoServiceEnv };
