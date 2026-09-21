import {
  BranchProtectionDAO,
  DiscussionDAO,
  EventDAO,
  ImportDAO,
  IssueDAO,
  MirrorDAO,
  NamespaceDAO,
  NotificationDAO,
  OrganizationDAO,
  OrganizationMemberDAO,
  ProjectDAO,
  PullRequestDAO,
  PullThreadDAO,
  ReleaseDAO,
  DeployKeyDAO,
  RepoCollaboratorDAO,
  RepositoryDAO,
  SecuritySettingsDAO,
  StarDAO,
  TokenRepoGrantDAO,
  UserDAO,
  WatchDAO,
  WikiDAO,
} from '@edge-git/backend-data/dao';
import type { RepositoryRow, RepoRole } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError, ForbiddenError, NotFoundError } from '@edge-git/backend-errors';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
import { isReservedNamespaceName } from '@edge-git/shared/constants';
import { EmailAddress, RepoFullName, TimestampUtil, UUIDUtil } from '@edge-git/shared/utils';
import { PermissionService } from '../permission/PermissionService';
import { cleanupRepoSidecars } from './repoCleanup';
import { RepoVisibilityService } from './RepoVisibilityService';

interface RepoServiceEnv {
  DB: D1Queryable;
  MAX_REPOS_PER_USER?: string;
}

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
  projectDAO?: () => Promise<ProjectDAO>;
  discussionDAO?: () => Promise<DiscussionDAO>;
  wikiDAO?: () => Promise<WikiDAO>;
  importDAO?: () => Promise<ImportDAO>;
  mirrorDAO?: () => Promise<MirrorDAO>;
  deployKeyDAO?: () => Promise<DeployKeyDAO>;
  tokenGrantDAO?: () => Promise<TokenRepoGrantDAO>;
  securitySettingsDAO?: () => Promise<SecuritySettingsDAO>;
  permissionService?: () => Promise<PermissionService>;
  config?: AppConfiguration;
}

class RepoService {
  private readonly deps: Required<RepoServiceDeps>;
  private readonly visibility: RepoVisibilityService;

  constructor(
    private readonly env: RepoServiceEnv,
    deps: RepoServiceDeps = {},
  ) {
    const permissionService =
      deps.permissionService ??
      ((): Promise<PermissionService> =>
        Promise.resolve(
          new PermissionService(this.env, {
            organizationDAO: deps.organizationDAO ?? (() => Promise.resolve(new OrganizationDAO(env.DB))),
            organizationMemberDAO: deps.organizationMemberDAO ?? (() => Promise.resolve(new OrganizationMemberDAO(env.DB))),
            repoCollaboratorDAO: deps.repoCollaboratorDAO ?? (() => Promise.resolve(new RepoCollaboratorDAO(env.DB))),
            namespaceDAO: deps.namespaceDAO ?? (() => Promise.resolve(new NamespaceDAO(env.DB))),
          }),
        ));
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
      projectDAO: () => Promise.resolve(new ProjectDAO(env.DB)),
      discussionDAO: () => Promise.resolve(new DiscussionDAO(env.DB)),
      wikiDAO: () => Promise.resolve(new WikiDAO(env.DB)),
      importDAO: () => Promise.resolve(new ImportDAO(env.DB)),
      mirrorDAO: () => Promise.resolve(new MirrorDAO(env.DB)),
      deployKeyDAO: () => Promise.resolve(new DeployKeyDAO(env.DB)),
      tokenGrantDAO: () => Promise.resolve(new TokenRepoGrantDAO(env.DB)),
      securitySettingsDAO: () => Promise.resolve(new SecuritySettingsDAO(env.DB)),
      permissionService,
      config: AppConfiguration.fromEnv(env),
      ...deps,
    };
    this.visibility = new RepoVisibilityService({
      repositoryDAO: this.deps.repositoryDAO,
      organizationDAO: this.deps.organizationDAO,
      organizationMemberDAO: this.deps.organizationMemberDAO,
      repoCollaboratorDAO: this.deps.repoCollaboratorDAO,
      permissionService: this.deps.permissionService,
    });
  }

  public static validateNames(owner: string, name: string): void {
    try {
      RepoFullName.parse(owner, name);
    } catch {
      throw new BadRequestError('Invalid owner or repository name');
    }
    if (isReservedNamespaceName(owner.trim())) {
      throw new BadRequestError('Username is reserved');
    }
  }

  private async permission(): Promise<PermissionService> {
    return this.deps.permissionService();
  }

  public async getRole(viewerEmail: string | null, repo: RepositoryRow | null): Promise<RepoRole | null> {
    return this.visibility.getRole(viewerEmail, repo);
  }

  private async resolveCallerUsernameCi(userEmail: string): Promise<string | null> {
    const normalized = EmailAddress.normalize(userEmail);
    try {
      const userDao = await this.deps.userDAO();
      const user = await userDao.getByEmail(normalized);
      if (user?.username) return user.username.toLowerCase();
    } catch {
      // ignore — fall back to email prefix below
    }
    const prefix = normalized.split('@', 1)[0]?.toLowerCase() ?? '';
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
    const normalizedOwner = RepoFullName.normalizeOwner(owner);
    const dao = await this.deps.repositoryDAO();
    RepoService.validateNames(normalizedOwner, name);
    const existing = await dao.getByOwnerAndName(normalizedOwner, name);
    if (existing) {
      throw new BadRequestError('Repository already exists');
    }
    const owned = await dao.listByOwnerEmail(userEmail, 1000).catch(() => []);
    const max = this.deps.config.getMaxReposPerUser();
    if (owned.length >= max) {
      throw new BadRequestError(`Maximum ${max} repositories per user`);
    }

    const ownerCi = normalizedOwner.toLowerCase();
    const callerCi = await this.resolveCallerUsernameCi(userEmail);
    const callerEmail = EmailAddress.normalize(userEmail);
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const id = UUIDUtil.getRandomUUID();

    // Self-owned fast path (covers legacy fakes with no users/orgs tables).
    if (callerCi && ownerCi === callerCi) {
      await dao.create({
        id,
        ownerEmail: callerEmail,
        owner: normalizedOwner,
        name,
        description,
        isPrivate,
        now,
        ownerType: 'user',
        ownerUserEmail: callerEmail,
        forkedFromRepoId: opts.forkedFromRepoId ?? null,
        forkedFromFullName: opts.forkedFromFullName ?? null,
      });
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
    await dao.create({
      id,
      ownerEmail: callerEmail,
      owner: normalizedOwner,
      name,
      description,
      isPrivate,
      now,
      ownerType: 'user',
      ownerUserEmail: callerEmail,
      forkedFromRepoId: opts.forkedFromRepoId ?? null,
      forkedFromFullName: opts.forkedFromFullName ?? null,
    });
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
    return this.visibility.listVisibleForUser(userEmail, (email) => this.resolveCallerUsernameCi(email), limit);
  }

  public async requireRole(
    owner: string,
    name: string,
    viewerEmail: string | null,
    minimum: RepoRole,
  ): Promise<{ repo: RepositoryRow; role: RepoRole }> {
    return this.visibility.requireRole(owner, name, viewerEmail, minimum);
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
    await dao.update(repo.id, {
      description: patch.description,
      isPrivate: patch.isPrivate,
      now: TimestampUtil.getCurrentUnixTimestampInSeconds(),
    });
    const updated = await dao.getById(repo.id);
    if (!updated) {
      throw new NotFoundError('Repository not found');
    }
    return updated;
  }

  public async deleteRepo(owner: string, name: string, userEmail: string): Promise<{ id: string }> {
    const repo = await this.requireOwner(owner, name, userEmail);
    await cleanupRepoSidecars(this.deps, repo.id);
    const repositoryDAO = await this.deps.repositoryDAO();
    await repositoryDAO.deleteById(repo.id);
    return { id: repo.id };
  }
}

export { RepoService };
export type { RepoServiceDeps, RepoServiceEnv };
