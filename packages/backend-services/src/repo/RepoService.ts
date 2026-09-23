import {
  AuditLogDAO,
  BranchProtectionDAO,
  CheckRunDAO,
  CollaborationDAO,
  DeletedRepoDoDAO,
  DiscussionDAO,
  EventDAO,
  ImportDAO,
  IssueDAO,
  MirrorDAO,
  NamespaceDAO,
  NotificationDAO,
  NumberingDAO,
  OrganizationDAO,
  OrganizationMemberDAO,
  ProjectDAO,
  PullRequestDAO,
  PullThreadDAO,
  ReleaseDAO,
  DeployKeyDAO,
  RepoCollaboratorDAO,
  RepositoryDAO,
  SearchDAO,
  SecuritySettingsDAO,
  StarDAO,
  TeamRepoGrantDAO,
  TokenRepoGrantDAO,
  UserDAO,
  WatchDAO,
  WebhookDAO,
  WebhookDeliveryDAO,
  WikiDAO,
} from '@edge-git/backend-data/dao';
import type { RepositoryRow, RepoRole } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError, NotFoundError } from '@edge-git/backend-errors';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
import { isReservedNamespaceName } from '@edge-git/shared/constants';
import { EmailAddress, RepoFullName, TimestampUtil, UUIDUtil, repoDoKeyForFullName } from '@edge-git/shared/utils';
import { PermissionService } from '../permission/PermissionService';
import { cleanupRepoSidecars } from './repoCleanup';
import { RepoVisibilityService } from './RepoVisibilityService';
import { checkRepoQuota, classifyCreatePath, throwIfForbidden, validateRepoPatch } from './RepoCreatePolicy';

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
  deletedRepoDoDAO?: () => Promise<DeletedRepoDoDAO>;
  numberingDAO?: () => Promise<NumberingDAO>;
  searchDAO?: () => Promise<SearchDAO>;
  tokenGrantDAO?: () => Promise<TokenRepoGrantDAO>;
  securitySettingsDAO?: () => Promise<SecuritySettingsDAO>;
  collaborationDAO?: () => Promise<CollaborationDAO>;
  webhookDAO?: () => Promise<WebhookDAO>;
  webhookDeliveryDAO?: () => Promise<WebhookDeliveryDAO>;
  auditLogDAO?: () => Promise<AuditLogDAO>;
  teamGrantDAO?: () => Promise<TeamRepoGrantDAO>;
  checkRunDAO?: () => Promise<CheckRunDAO>;
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
      importDAO: () =>
        Promise.reject<ImportDAO>(new Error('RepoService requires an injected importDAO outside request scope.')),
      mirrorDAO: () =>
        Promise.reject<MirrorDAO>(new Error('RepoService requires an injected mirrorDAO outside request scope.')),
      deployKeyDAO: () => Promise.resolve(new DeployKeyDAO(env.DB)),
      deletedRepoDoDAO: () => Promise.resolve(new DeletedRepoDoDAO(env.DB)),
      numberingDAO: () => Promise.resolve(new NumberingDAO(env.DB)),
      searchDAO: () => Promise.resolve(new SearchDAO(env.DB)),
      tokenGrantDAO: () => Promise.resolve(new TokenRepoGrantDAO(env.DB)),
      securitySettingsDAO: () => Promise.resolve(new SecuritySettingsDAO(env.DB)),
      collaborationDAO: () => Promise.resolve(new CollaborationDAO(env.DB)),
      webhookDAO: () =>
        Promise.reject<WebhookDAO>(new Error('RepoService requires an injected webhookDAO outside request scope.')),
      webhookDeliveryDAO: () => Promise.resolve(new WebhookDeliveryDAO(env.DB)),
      auditLogDAO: () => Promise.resolve(new AuditLogDAO(env.DB)),
      teamGrantDAO: () => Promise.resolve(new TeamRepoGrantDAO(env.DB)),
      checkRunDAO: () => Promise.resolve(new CheckRunDAO(env.DB)),
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
    opts: { forkedFromRepoId?: string | null } = {},
  ): Promise<{ id: string }> {
    const normalizedOwner = RepoFullName.normalizeOwner(owner);
    const dao = await this.deps.repositoryDAO();
    RepoService.validateNames(normalizedOwner, name);
    const existing = await dao.getByOwnerAndName(normalizedOwner, name);
    if (existing) {
      throw new BadRequestError('Repository already exists');
    }
    const owned = await dao.listByOwnerEmail(userEmail, 1000).catch(() => []);
    checkRepoQuota(owned.length, this.deps.config.getMaxReposPerUser());

    const ownerCi = normalizedOwner.toLowerCase();
    const callerCi = await this.resolveCallerUsernameCi(userEmail);
    const callerEmail = EmailAddress.normalize(userEmail);
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const id = UUIDUtil.getRandomUUID();

    // Resolve the org/namespace lookups up front; the precedence decision
    // itself is the pure `classifyCreatePath` policy below.
    let org: { id: string; username: string } | null = null;
    try {
      const orgDao = await this.deps.organizationDAO();
      org = await orgDao.getByUsernameCi(ownerCi);
    } catch {
      org = null;
    }
    let isOrgMember = false;
    if (org) {
      try {
        const memberDao = await this.deps.organizationMemberDAO();
        isOrgMember = (await memberDao.get(org.id, callerEmail)) !== null;
      } catch {
        isOrgMember = false;
      }
    }
    let namespaceOwnerEmail: string | null = null;
    if (!org && (!callerCi || ownerCi !== callerCi)) {
      try {
        const nsDao = await this.deps.namespaceDAO();
        const ns = await nsDao.get(ownerCi);
        namespaceOwnerEmail = ns?.user_email?.toLowerCase() ?? null;
      } catch {
        namespaceOwnerEmail = null;
      }
    }

    const path = classifyCreatePath({ ownerCi, callerCi, org, isOrgMember, namespaceOwnerEmail, callerEmail });
    throwIfForbidden(path);

    // Self-owned fast path (covers legacy fakes with no users/orgs tables).
    if (path.kind === 'self' || path.kind === 'legacy') {
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
      });
      return { id };
    }

    // Org-owned path: caller is owner or member (both may create).
    await dao.create({
      id,
      ownerEmail: callerEmail,
      owner: path.owner,
      name,
      description,
      isPrivate,
      now,
      ownerType: 'org',
      orgId: path.orgId,
      forkedFromRepoId: opts.forkedFromRepoId ?? null,
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
    validateRepoPatch(patch);
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
    // Enqueue a vacuum tombstone so the background `RepoVacuumTask` can
    // reclaim the REPO + CHECK_RUNNER isolate storage and KV caches once the
    // name stays free. Best-effort: the synchronous targeted DO purge in the
    // route already removed the live content; a missed tombstone only leaks
    // reclaimed-later SQLite pages, never user-visible data.
    try {
      const tombstones = await this.deps.deletedRepoDoDAO();
      const fullName = `${repo.owner}/${repo.name}`;
      await tombstones.enqueue(
        repoDoKeyForFullName(fullName),
        fullName,
        repo.id,
        TimestampUtil.getCurrentUnixTimestampInSeconds(),
      );
    } catch (error) {
      console.warn(`[WARN] [repoCleanup] vacuum tombstone enqueue failed: ${String(error)}`);
    }
    return { id: repo.id };
  }
}

export { RepoService };
export type { RepoServiceDeps, RepoServiceEnv };
