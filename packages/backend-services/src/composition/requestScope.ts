import { BranchProtectionDAO, CollaborationDAO, DiscussionDAO, IssueDAO, NamespaceDAO, OrganizationDAO, OrganizationMemberDAO, ProjectDAO, PullRequestDAO, PullThreadDAO, ReleaseDAO, RepoCollaboratorDAO, RepositoryDAO, SearchDAO, SnippetDAO, UserAccessTokenDAO, UserDAO, WikiDAO } from '@edge-git/backend-data/dao';
import { AuditLogDAO, CheckRunDAO, DeployKeyDAO, EventDAO, ImportDAO, MirrorDAO, NotificationDAO, SecuritySettingsDAO, StarDAO, TeamDAO, TeamMemberDAO, TeamRepoGrantDAO, TokenRepoGrantDAO, WatchDAO, WebhookDAO, WebhookDeliveryDAO } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { Container, memoizeAsync } from '@edge-git/backend-runtime/di';
import type { Token } from '@edge-git/backend-runtime/di';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
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
import { AuditService } from '@edge-git/backend-services/audit';
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
import { Tokens } from './tokens';

// Minimal structural env for scope creation. Secrets are resolved lazily and
// memoized — requests that never touch encrypted state pay no Secrets Store
// round-trip.
//
// NOTE: no `[key: string]: unknown` index signature on purpose — interfaces
// (e.g. endpoint `*Env`) do not carry an implicit index signature, so a target
// with one would reject every `createRequestScope(env)` call site. Extra
// bindings are still assignable structurally; services receive `env as never`.
interface RequestScopeEnv {
  DB: D1Queryable;
  AES_ENCRYPTION_KEY_SECRET?: { get(): Promise<string> };
}

interface RequestKeys {
  masterKey: string;
}

// Table-driven DAO wiring (Otter pattern). Each entry is a lazy factory
// thunk so `createRequestScope` never touches a DAO constructor eagerly —
// unit tests with partial `vi.mock('@edge-git/backend-data/dao')` modules
// keep working; only the DAOs a test actually resolves are constructed.
// Factories stay memoized via `memoizeAsync` — D1 objects are cheap, but
// Secrets Store round-trips (via `Tokens.Keys`) are not.

// Composition root: builds a per-request child scope wiring DAOs → services.
// Replaces the former scattered `new X(env)` / `new XDAO(env.DB)`
// call sites in apps/api and apps/background.
function createRequestScope(env: RequestScopeEnv): Container {
  const scope = new Container();
  scope.bindValue(Tokens.Env, env);
  scope.bindValue(Tokens.Db, env.DB);

  const masterKey = memoizeAsync(() => {
    if (!env.AES_ENCRYPTION_KEY_SECRET) throw new Error('AES_ENCRYPTION_KEY_SECRET is not configured for this scope.');
    return env.AES_ENCRYPTION_KEY_SECRET.get();
  });
  const keys = memoizeAsync(async (): Promise<RequestKeys> => ({ masterKey: await masterKey() }));
  scope.bindValue(Tokens.Keys, keys);

  const daoDefs: Array<[string, () => Promise<unknown>]> = [
    ['UserDAO', () => Promise.resolve(new UserDAO(env.DB))],
    ['RepositoryDAO', () => Promise.resolve(new RepositoryDAO(env.DB))],
    ['UserAccessTokenDAO', () => Promise.resolve(new UserAccessTokenDAO(env.DB))],
    ['IssueDAO', () => Promise.resolve(new IssueDAO(env.DB))],
    ['PullRequestDAO', () => Promise.resolve(new PullRequestDAO(env.DB))],
    ['PullThreadDAO', () => Promise.resolve(new PullThreadDAO(env.DB))],
    ['NamespaceDAO', () => Promise.resolve(new NamespaceDAO(env.DB))],
    ['OrganizationDAO', () => Promise.resolve(new OrganizationDAO(env.DB))],
    ['OrganizationMemberDAO', () => Promise.resolve(new OrganizationMemberDAO(env.DB))],
    ['RepoCollaboratorDAO', () => Promise.resolve(new RepoCollaboratorDAO(env.DB))],
    ['BranchProtectionDAO', () => Promise.resolve(new BranchProtectionDAO(env.DB))],
    ['CheckRunDAO', () => Promise.resolve(new CheckRunDAO(env.DB))],
    ['CollaborationDAO', () => Promise.resolve(new CollaborationDAO(env.DB))],
    ['SearchDAO', () => Promise.resolve(new SearchDAO(env.DB))],
    ['StarDAO', () => Promise.resolve(new StarDAO(env.DB))],
    ['WatchDAO', () => Promise.resolve(new WatchDAO(env.DB))],
    ['EventDAO', () => Promise.resolve(new EventDAO(env.DB))],
    ['NotificationDAO', () => Promise.resolve(new NotificationDAO(env.DB))],
    ['WebhookDAO', () => Promise.resolve(new WebhookDAO(env.DB))],
    ['WebhookDeliveryDAO', () => Promise.resolve(new WebhookDeliveryDAO(env.DB))],
    ['ReleaseDAO', () => Promise.resolve(new ReleaseDAO(env.DB))],
    ['ProjectDAO', () => Promise.resolve(new ProjectDAO(env.DB))],
    ['DiscussionDAO', () => Promise.resolve(new DiscussionDAO(env.DB))],
    ['WikiDAO', () => Promise.resolve(new WikiDAO(env.DB))],
    ['SnippetDAO', () => Promise.resolve(new SnippetDAO(env.DB))],
    ['TeamDAO', () => Promise.resolve(new TeamDAO(env.DB))],
    ['TeamMemberDAO', () => Promise.resolve(new TeamMemberDAO(env.DB))],
    ['TeamRepoGrantDAO', () => Promise.resolve(new TeamRepoGrantDAO(env.DB))],
    ['AuditLogDAO', () => Promise.resolve(new AuditLogDAO(env.DB))],
    ['ImportDAO', () => Promise.resolve(new ImportDAO(env.DB))],
    ['MirrorDAO', () => Promise.resolve(new MirrorDAO(env.DB))],
    ['DeployKeyDAO', () => Promise.resolve(new DeployKeyDAO(env.DB))],
    ['TokenRepoGrantDAO', () => Promise.resolve(new TokenRepoGrantDAO(env.DB))],
    ['SecuritySettingsDAO', () => Promise.resolve(new SecuritySettingsDAO(env.DB))],
  ];
  const daoFactories = {} as Record<string, () => Promise<unknown>>;
  for (const [tokenName, create] of daoDefs) {
    const factory = memoizeAsync(create);
    daoFactories[tokenName] = factory;
    scope.bindValue((Tokens as Record<string, Token<unknown>>)[tokenName], factory);
  }
  const getDao = <T>(name: string): (() => Promise<T>) => daoFactories[name] as () => Promise<T>;

  const repositoryDAO = getDao<RepositoryDAO>('RepositoryDAO');
  const issueDAO = getDao<IssueDAO>('IssueDAO');
  const pullRequestDAO = getDao<PullRequestDAO>('PullRequestDAO');
  const pullThreadDAO = getDao<PullThreadDAO>('PullThreadDAO');
  const branchProtectionDAO = getDao<BranchProtectionDAO>('BranchProtectionDAO');
  const userDAO = getDao<UserDAO>('UserDAO');
  const organizationDAO = getDao<OrganizationDAO>('OrganizationDAO');
  const organizationMemberDAO = getDao<OrganizationMemberDAO>('OrganizationMemberDAO');
  const repoCollaboratorDAO = getDao<RepoCollaboratorDAO>('RepoCollaboratorDAO');
  const namespaceDAO = getDao<NamespaceDAO>('NamespaceDAO');
  const starDAO = getDao<StarDAO>('StarDAO');
  const watchDAO = getDao<WatchDAO>('WatchDAO');
  const eventDAO = getDao<EventDAO>('EventDAO');
  const notificationDAO = getDao<NotificationDAO>('NotificationDAO');
  const webhookDAO = getDao<WebhookDAO>('WebhookDAO');
  const webhookDeliveryDAO = getDao<WebhookDeliveryDAO>('WebhookDeliveryDAO');
  const releaseDAO = getDao<ReleaseDAO>('ReleaseDAO');
  const projectDAO = getDao<ProjectDAO>('ProjectDAO');
  const discussionDAO = getDao<DiscussionDAO>('DiscussionDAO');
  const wikiDAO = getDao<WikiDAO>('WikiDAO');
  const snippetDAO = getDao<SnippetDAO>('SnippetDAO');
  const teamDAO = getDao<TeamDAO>('TeamDAO');
  const teamMemberDAO = getDao<TeamMemberDAO>('TeamMemberDAO');
  const teamGrantDAO = getDao<TeamRepoGrantDAO>('TeamRepoGrantDAO');
  const auditLogDAO = getDao<AuditLogDAO>('AuditLogDAO');
  const importDAO = getDao<ImportDAO>('ImportDAO');
  const mirrorDAO = getDao<MirrorDAO>('MirrorDAO');
  const deployKeyDAO = getDao<DeployKeyDAO>('DeployKeyDAO');
  const tokenDAO = getDao<UserAccessTokenDAO>('UserAccessTokenDAO');
  const checkRunDAO = getDao<CheckRunDAO>('CheckRunDAO');
  const collaborationDAO = getDao<CollaborationDAO>('CollaborationDAO');
  const searchDAO = getDao<SearchDAO>('SearchDAO');
  const tokenGrantDAO = getDao<TokenRepoGrantDAO>('TokenRepoGrantDAO');
  const securitySettingsDAO = getDao<SecuritySettingsDAO>('SecuritySettingsDAO');

  scope.bind(Tokens.AccessAuthService, () => new AccessAuthService(env as never));
  scope.bind(Tokens.TokenService, () => new TokenService(env as never, { tokenDAO, repositoryDAO, tokenGrantDAO }));
  scope.bind(Tokens.CheckService, () => new CheckService(env as never, { checkRunDAO }));
  scope.bind(Tokens.BranchProtectionService, () => new BranchProtectionService(env as never, { branchProtectionDAO }));
  scope.bind(
    Tokens.ForkService,
    (container) => new ForkService(env as never, { repositoryDAO, userDAO, organizationDAO, organizationMemberDAO, repoCollaboratorDAO, namespaceDAO, permissionService: () => Promise.resolve(container.get(Tokens.PermissionService)) }),
  );
  scope.bind(
    Tokens.RepoService,
    (container) => new RepoService(env as never, { repositoryDAO, issueDAO, pullRequestDAO, pullThreadDAO, branchProtectionDAO, userDAO, organizationDAO, organizationMemberDAO, repoCollaboratorDAO, namespaceDAO, starDAO, watchDAO, eventDAO, notificationDAO, releaseDAO, projectDAO, discussionDAO, wikiDAO, importDAO, mirrorDAO, deployKeyDAO, tokenGrantDAO, securitySettingsDAO, permissionService: () => Promise.resolve(container.get(Tokens.PermissionService)), config: AppConfiguration.fromEnv(env) }),
  );
  scope.bind(Tokens.UserService, () => new UserService(env as never, { userDAO, namespaceDAO, organizationDAO, repositoryDAO }));
  scope.bind(Tokens.IssueService, () => new IssueService(env as never, { issueDAO }));
  scope.bind(Tokens.PullRequestService, () => new PullRequestService(env as never, { pullRequestDAO }));
  scope.bind(Tokens.PullThreadService, () => new PullThreadService(env as never, { pullRequestDAO, pullThreadDAO }));
  scope.bind(
    Tokens.OrganizationService,
    () => new OrganizationService(env as never, { organizationDAO, organizationMemberDAO, namespaceDAO, userDAO, repositoryDAO }),
  );
  scope.bind(
    Tokens.TeamService,
    () => new TeamService(env as never, { teamDAO, teamMemberDAO, teamGrantDAO, organizationDAO, organizationMemberDAO, userDAO, repositoryDAO }),
  );
  scope.bind(Tokens.AuditService, () => new AuditService(env as never, { auditLogDAO, organizationDAO, organizationMemberDAO }));
  // Single PermissionService binding (Otter pattern). Dependent services
  // resolve it lazily via the container instead of `new PermissionService`
  // per factory (previously 4 duplicated inline factories).
  scope.bind(
    Tokens.PermissionService,
    () => new PermissionService(env as never, { organizationDAO, organizationMemberDAO, repoCollaboratorDAO, namespaceDAO, teamMemberDAO, teamGrantDAO, teamDAO }),
  );
  scope.bind(
    Tokens.SearchService,
    (container) =>
      new SearchService(env as never, {
        searchDAO,
        repositoryDAO,
        issueDAO,
        permissionService: () => Promise.resolve(container.get(Tokens.PermissionService)),
      }),
  );
  scope.bind(Tokens.StarService, () => new StarService(env as never, { starDAO }));
  scope.bind(Tokens.CollaborationService, () => new CollaborationService(env as never, { collaborationDAO }));
  scope.bind(Tokens.ReleaseService, () => new ReleaseService(env as never, { releaseDAO }));
  scope.bind(
    Tokens.RealtimeService,
    (container) =>
      new RealtimeService(env as never, {
        repositoryDAO,
        permissionService: () => Promise.resolve(container.get(Tokens.PermissionService)),
      }),
  );
  scope.bind(Tokens.ProjectService, () => new ProjectService(env as never, { projectDAO }));
  scope.bind(Tokens.DiscussionService, () => new DiscussionService(env as never, { discussionDAO }));
  scope.bind(Tokens.WikiService, () => new WikiService(env as never, { wikiDAO }));
  scope.bind(Tokens.SnippetService, () => new SnippetService(env as never, { snippetDAO }));
  scope.bind(Tokens.WatchService, () => new WatchService(env as never, { watchDAO }));
  scope.bind(Tokens.ImportService, () => new ImportService(env as never, { importDAO }));
  scope.bind(Tokens.MirrorService, () => new MirrorService(env as never, { mirrorDAO }));
  scope.bind(Tokens.DeployKeyService, () => new DeployKeyService(env as never, { deployKeyDAO }));
  scope.bind(Tokens.SecuritySettingsService, () => new SecuritySettingsService(env as never, { settingsDAO: securitySettingsDAO }));
  scope.bind(Tokens.ActivityService, () => new ActivityService(env as never, { eventDAO }));
  scope.bind(Tokens.WebhookService, () => new WebhookService(env as never, { webhookDAO }));
  scope.bind(Tokens.WebhookDeliveryService, () => new WebhookDeliveryService(env as never, { webhookDAO, deliveryDAO: webhookDeliveryDAO }));
  scope.bind(
    Tokens.NotificationService,
    (container) =>
      new NotificationService(env as never, {
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

  return scope;
}

export { createRequestScope };
export type { RequestKeys, RequestScopeEnv };
