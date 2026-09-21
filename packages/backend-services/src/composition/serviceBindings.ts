// NOTE: service imports use the package entry points (`@edge-git/...`)
// rather than relative file paths so route unit tests mocking those modules
// (`vi.mock('@edge-git/backend-services/repo', ...)`) keep working
// after migration to `scope.get(...)`. Runtime behavior is identical.
import { AccessAuthService, TokenService } from '@edge-git/backend-services/auth';
import { BranchProtectionService } from '@edge-git/backend-services/protection';
import { CheckService } from '@edge-git/backend-services/checks';
import { ForkService } from '@edge-git/backend-services/fork';
import { RepoService } from '@edge-git/backend-services/repo';
import { UserService } from '@edge-git/backend-services/user';
import { IssueService } from '@edge-git/backend-services/issue';
import { PullRequestService } from '@edge-git/backend-services/pull';
import { PullThreadService } from '@edge-git/backend-services/pull/PullThreadService';
import { OrganizationService } from '@edge-git/backend-services/org';
import { TeamService } from '@edge-git/backend-services/team';
import { AuditObserverRegistry, AuditService } from '@edge-git/backend-services/audit';
import { PermissionService } from '@edge-git/backend-services/permission';
import { SearchService } from '@edge-git/backend-services/search';
import { ActivityService } from '@edge-git/backend-services/social/ActivityService';
import { NotificationService } from '@edge-git/backend-services/social/NotificationService';
import { StarService } from '@edge-git/backend-services/social/StarService';
import { WatchService } from '@edge-git/backend-services/social/WatchService';
import { WebhookDeliveryService } from '@edge-git/backend-services/webhook/WebhookDeliveryService';
import { WebhookService } from '@edge-git/backend-services/webhook/WebhookService';
import { CollaborationService } from '@edge-git/backend-services/collab';
import { DiscussionService } from '@edge-git/backend-services/discussion';
import { ProjectService } from '@edge-git/backend-services/project';
import { ReleaseService } from '@edge-git/backend-services/release';
import { RealtimeService } from '@edge-git/backend-services/realtime';
import { SnippetService } from '@edge-git/backend-services/snippet';
import { ImportService } from '@edge-git/backend-services/transfer/ImportService';
import { MirrorService } from '@edge-git/backend-services/transfer/MirrorService';
import { DeployKeyService } from '@edge-git/backend-services/deploykey';
import { SecuritySettingsService } from '@edge-git/backend-services/security';
import { WikiService } from '@edge-git/backend-services/wiki';
import type {
  AuditLogDAO,
  BranchProtectionDAO,
  CheckRunDAO,
  CollaborationDAO,
  DeployKeyDAO,
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
  RepoCollaboratorDAO,
  RepositoryDAO,
  SearchDAO,
  SecuritySettingsDAO,
  SnippetDAO,
  StarDAO,
  TeamDAO,
  TeamMemberDAO,
  TeamRepoGrantDAO,
  TokenRepoGrantDAO,
  UserAccessTokenDAO,
  UserDAO,
  WatchDAO,
  WebhookDAO,
  WebhookDeliveryDAO,
  WikiDAO,
} from '@edge-git/backend-data/dao';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
import type { Container, Token } from '@edge-git/backend-runtime/di';
import { Tokens } from './tokens';
import { createService } from './serviceFactory';
import type { RequestScopeEnv } from './serviceFactory';

// Service bindings for the per-request composition root. DAO thunks come
// from the container (bound by `bindDaoBindings`); services taking a
// `permissionService` resolve the single shared `PermissionService` via
// the container instead of `new` (Otter pattern).
function bindServiceBindings(scope: Container, env: RequestScopeEnv): void {
  const getDao = <T>(token: Token<() => Promise<T>>): (() => Promise<T>) => scope.get(token);

  const repositoryDAO = getDao<RepositoryDAO>(Tokens.RepositoryDAO);
  const issueDAO = getDao<IssueDAO>(Tokens.IssueDAO);
  const pullRequestDAO = getDao<PullRequestDAO>(Tokens.PullRequestDAO);
  const pullThreadDAO = getDao<PullThreadDAO>(Tokens.PullThreadDAO);
  const branchProtectionDAO = getDao<BranchProtectionDAO>(Tokens.BranchProtectionDAO);
  const userDAO = getDao<UserDAO>(Tokens.UserDAO);
  const organizationDAO = getDao<OrganizationDAO>(Tokens.OrganizationDAO);
  const organizationMemberDAO = getDao<OrganizationMemberDAO>(Tokens.OrganizationMemberDAO);
  const repoCollaboratorDAO = getDao<RepoCollaboratorDAO>(Tokens.RepoCollaboratorDAO);
  const namespaceDAO = getDao<NamespaceDAO>(Tokens.NamespaceDAO);
  const numberingDAO = getDao<NumberingDAO>(Tokens.NumberingDAO);
  const starDAO = getDao<StarDAO>(Tokens.StarDAO);
  const watchDAO = getDao<WatchDAO>(Tokens.WatchDAO);
  const eventDAO = getDao<EventDAO>(Tokens.EventDAO);
  const notificationDAO = getDao<NotificationDAO>(Tokens.NotificationDAO);
  const webhookDAO = getDao<WebhookDAO>(Tokens.WebhookDAO);
  const webhookDeliveryDAO = getDao<WebhookDeliveryDAO>(Tokens.WebhookDeliveryDAO);
  const releaseDAO = getDao<ReleaseDAO>(Tokens.ReleaseDAO);
  const projectDAO = getDao<ProjectDAO>(Tokens.ProjectDAO);
  const discussionDAO = getDao<DiscussionDAO>(Tokens.DiscussionDAO);
  const wikiDAO = getDao<WikiDAO>(Tokens.WikiDAO);
  const snippetDAO = getDao<SnippetDAO>(Tokens.SnippetDAO);
  const teamDAO = getDao<TeamDAO>(Tokens.TeamDAO);
  const teamMemberDAO = getDao<TeamMemberDAO>(Tokens.TeamMemberDAO);
  const teamGrantDAO = getDao<TeamRepoGrantDAO>(Tokens.TeamRepoGrantDAO);
  const auditLogDAO = getDao<AuditLogDAO>(Tokens.AuditLogDAO);
  const importDAO = getDao<ImportDAO>(Tokens.ImportDAO);
  const mirrorDAO = getDao<MirrorDAO>(Tokens.MirrorDAO);
  const deployKeyDAO = getDao<DeployKeyDAO>(Tokens.DeployKeyDAO);
  const tokenDAO = getDao<UserAccessTokenDAO>(Tokens.UserAccessTokenDAO);
  const checkRunDAO = getDao<CheckRunDAO>(Tokens.CheckRunDAO);
  const collaborationDAO = getDao<CollaborationDAO>(Tokens.CollaborationDAO);
  const searchDAO = getDao<SearchDAO>(Tokens.SearchDAO);
  const tokenGrantDAO = getDao<TokenRepoGrantDAO>(Tokens.TokenRepoGrantDAO);
  const securitySettingsDAO = getDao<SecuritySettingsDAO>(Tokens.SecuritySettingsDAO);

  scope.bind(Tokens.AccessAuthService, () => createService(AccessAuthService, env));
  scope.bind(Tokens.TokenService, () => createService(TokenService, env, { tokenDAO, repositoryDAO, tokenGrantDAO }));
  scope.bind(Tokens.CheckService, () => createService(CheckService, env, { checkRunDAO }));
  scope.bind(Tokens.BranchProtectionService, () => createService(BranchProtectionService, env, { branchProtectionDAO }));
  scope.bind(
    Tokens.ForkService,
    (container) =>
      createService(ForkService, env, {
        repositoryDAO,
        userDAO,
        organizationDAO,
        organizationMemberDAO,
        repoCollaboratorDAO,
        namespaceDAO,
        permissionService: () => Promise.resolve(container.get(Tokens.PermissionService)),
      }),
  );
  scope.bind(
    Tokens.RepoService,
    (container) =>
      createService(RepoService, env, {
        repositoryDAO,
        issueDAO,
        pullRequestDAO,
        pullThreadDAO,
        branchProtectionDAO,
        userDAO,
        organizationDAO,
        organizationMemberDAO,
        repoCollaboratorDAO,
        namespaceDAO,
        starDAO,
        watchDAO,
        eventDAO,
        notificationDAO,
        releaseDAO,
        projectDAO,
        discussionDAO,
        wikiDAO,
        importDAO,
        mirrorDAO,
        deployKeyDAO,
        tokenGrantDAO,
        securitySettingsDAO,
        permissionService: () => Promise.resolve(container.get(Tokens.PermissionService)),
        config: AppConfiguration.fromEnv(env),
      }),
  );
  scope.bind(
    Tokens.UserService,
    () =>
      createService(UserService, env, {
        userDAO,
        namespaceDAO,
        organizationDAO,
        repositoryDAO,
        issueDAO,
        pullRequestDAO,
        eventDAO,
        notificationDAO,
        webhookDAO,
      }),
  );
  scope.bind(Tokens.IssueService, () => createService(IssueService, env, { issueDAO, numberingDAO }));
  scope.bind(Tokens.PullRequestService, () => createService(PullRequestService, env, { pullRequestDAO, numberingDAO }));
  scope.bind(Tokens.PullThreadService, () => createService(PullThreadService, env, { pullRequestDAO, pullThreadDAO }));
  scope.bind(
    Tokens.OrganizationService,
    () =>
      createService(OrganizationService, env, {
        organizationDAO,
        organizationMemberDAO,
        namespaceDAO,
        userDAO,
        repositoryDAO,
        issueDAO,
        pullRequestDAO,
        eventDAO,
        notificationDAO,
        webhookDAO,
      }),
  );
  scope.bind(
    Tokens.TeamService,
    () =>
      createService(TeamService, env, {
        teamDAO,
        teamMemberDAO,
        teamGrantDAO,
        organizationDAO,
        organizationMemberDAO,
        userDAO,
        repositoryDAO,
      }),
  );
  scope.bind(Tokens.AuditObserverRegistry, () => AuditObserverRegistry.withDefaults(auditLogDAO));
  scope.bind(
    Tokens.AuditService,
    (container) =>
      createService(AuditService, env, {
        auditLogDAO,
        organizationDAO,
        organizationMemberDAO,
        observers: container.get(Tokens.AuditObserverRegistry),
      }),
  );
  // Single PermissionService binding (Otter pattern). Dependent services
  // resolve it lazily via the container instead of `new PermissionService`
  // per factory (previously 4 duplicated inline factories).
  scope.bind(
    Tokens.PermissionService,
    () =>
      createService(PermissionService, env, {
        organizationDAO,
        organizationMemberDAO,
        repoCollaboratorDAO,
        namespaceDAO,
        teamMemberDAO,
        teamGrantDAO,
        teamDAO,
        // Production D1 has every migration: a missing table is deploy skew,
        // not a legacy DB — fail closed instead of degrading to public-read.
        strictSchema: !AppConfiguration.fromEnv(env).isBypassAllowed(),
      }),
  );
  scope.bind(
    Tokens.SearchService,
    (container) =>
      createService(SearchService, env, {
        searchDAO,
        repositoryDAO,
        issueDAO,
        permissionService: () => Promise.resolve(container.get(Tokens.PermissionService)),
      }),
  );
  scope.bind(Tokens.StarService, () => createService(StarService, env, { starDAO }));
  scope.bind(Tokens.CollaborationService, () => createService(CollaborationService, env, { collaborationDAO }));
  scope.bind(Tokens.ReleaseService, () => createService(ReleaseService, env, { releaseDAO }));
  scope.bind(
    Tokens.RealtimeService,
    (container) =>
      createService(RealtimeService, env, {
        repositoryDAO,
        permissionService: () => Promise.resolve(container.get(Tokens.PermissionService)),
      }),
  );
  scope.bind(Tokens.ProjectService, () => createService(ProjectService, env, { projectDAO, numberingDAO }));
  scope.bind(Tokens.DiscussionService, () => createService(DiscussionService, env, { discussionDAO, numberingDAO }));
  scope.bind(Tokens.WikiService, () => createService(WikiService, env, { wikiDAO }));
  scope.bind(Tokens.SnippetService, () => createService(SnippetService, env, { snippetDAO }));
  scope.bind(Tokens.WatchService, () => createService(WatchService, env, { watchDAO }));
  scope.bind(Tokens.ImportService, () => createService(ImportService, env, { importDAO }));
  scope.bind(Tokens.MirrorService, () => createService(MirrorService, env, { mirrorDAO }));
  scope.bind(Tokens.DeployKeyService, () => createService(DeployKeyService, env, { deployKeyDAO }));
  scope.bind(Tokens.SecuritySettingsService, () => createService(SecuritySettingsService, env, { settingsDAO: securitySettingsDAO }));
  scope.bind(Tokens.ActivityService, () => createService(ActivityService, env, { eventDAO }));
  scope.bind(Tokens.WebhookService, () => createService(WebhookService, env, { webhookDAO }));
  scope.bind(
    Tokens.WebhookDeliveryService,
    () => createService(WebhookDeliveryService, env, { webhookDAO, deliveryDAO: webhookDeliveryDAO }),
  );
  scope.bind(
    Tokens.NotificationService,
    (container) =>
      createService(NotificationService, env, {
        notificationDAO,
        watchDAO,
        userDAO,
        repositoryDAO,
        permissionService: () => Promise.resolve(container.get(Tokens.PermissionService)),
      }),
  );
  // Lazy bind so unit tests mocking `@edge-git/backend-runtime/config` with
  // only `ConfigurationManager` keep working; the factory only touches the
  // mocked module when the token is actually resolved.
  scope.bind(Tokens.AppConfig, () => AppConfiguration.fromEnv(env));
}

export { bindServiceBindings };
