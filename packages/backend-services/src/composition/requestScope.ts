import {
  BranchProtectionDAO,
  CollaborationDAO,
  DiscussionDAO,
  IssueDAO,
  NamespaceDAO,
  OrganizationDAO,
  OrganizationMemberDAO,
  ProjectDAO,
  PullRequestDAO,
  PullThreadDAO,
  ReleaseDAO,
  RepoCollaboratorDAO,
  RepositoryDAO,
  SearchDAO,
  SnippetDAO,
  UserAccessTokenDAO,
  UserDAO,
  WikiDAO,
} from '@edge-git/backend-data/dao';
import {
  AuditLogDAO,
  CheckRunDAO,
  DeployKeyDAO,
  EventDAO,
  ImportDAO,
  MirrorDAO,
  NotificationDAO,
  SecuritySettingsDAO,
  StarDAO,
  TeamDAO,
  TeamMemberDAO,
  TeamRepoGrantDAO,
  TokenRepoGrantDAO,
  WatchDAO,
  WebhookDAO,
  WebhookDeliveryDAO,
} from '@edge-git/backend-data/dao';
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

// Table-driven DAO wiring (Otter pattern). Each entry is keyed by its typed
// `Tokens.X` symbol directly — no stringly-typed lookup table and no
// `(Tokens as Record<...>)` cast. Each factory thunk is lazy + memoized via
// `memoizeAsync` so `createRequestScope` never touches a DAO constructor
// eagerly: unit tests with partial `vi.mock('@edge-git/backend-data/dao')`
// modules keep working; only the DAOs a test actually resolves are built.
// D1 objects are cheap, but Secrets Store round-trips (via `Tokens.Keys`)
// are not.

// Single audited unsafe-cast location for service envs. Services declare
// narrow `*Env` interfaces (e.g. `{ DB, MAX_* }`); the composition root holds
// the minimal `RequestScopeEnv`. Centralizing `as never` here keeps ~30 call
// sites readable and makes future `ServiceEnv` migration a one-line change.
function asServiceEnv(env: RequestScopeEnv): never {
  return env as never;
}

// Generic service factory (AWS `createService` pattern). Kills `new X(env)`
// boilerplate repetition and keeps ctor-injection visible in one place.
function createService<T, D>(Ctor: new (env: never, deps?: D) => T, env: RequestScopeEnv, deps?: D): T {
  return new Ctor(asServiceEnv(env), deps);
}

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

  const daoDefs: Array<[Token<() => Promise<unknown>>, () => Promise<unknown>]> = [
    [Tokens.UserDAO, () => Promise.resolve(new UserDAO(env.DB))],
    [Tokens.RepositoryDAO, () => Promise.resolve(new RepositoryDAO(env.DB))],
    [Tokens.UserAccessTokenDAO, () => Promise.resolve(new UserAccessTokenDAO(env.DB))],
    [Tokens.IssueDAO, () => Promise.resolve(new IssueDAO(env.DB))],
    [Tokens.PullRequestDAO, () => Promise.resolve(new PullRequestDAO(env.DB))],
    [Tokens.PullThreadDAO, () => Promise.resolve(new PullThreadDAO(env.DB))],
    [Tokens.NamespaceDAO, () => Promise.resolve(new NamespaceDAO(env.DB))],
    [Tokens.OrganizationDAO, () => Promise.resolve(new OrganizationDAO(env.DB))],
    [Tokens.OrganizationMemberDAO, () => Promise.resolve(new OrganizationMemberDAO(env.DB))],
    [Tokens.RepoCollaboratorDAO, () => Promise.resolve(new RepoCollaboratorDAO(env.DB))],
    [Tokens.BranchProtectionDAO, () => Promise.resolve(new BranchProtectionDAO(env.DB))],
    [Tokens.CheckRunDAO, () => Promise.resolve(new CheckRunDAO(env.DB))],
    [Tokens.CollaborationDAO, () => Promise.resolve(new CollaborationDAO(env.DB))],
    [Tokens.SearchDAO, () => Promise.resolve(new SearchDAO(env.DB))],
    [Tokens.StarDAO, () => Promise.resolve(new StarDAO(env.DB))],
    [Tokens.WatchDAO, () => Promise.resolve(new WatchDAO(env.DB))],
    [Tokens.EventDAO, () => Promise.resolve(new EventDAO(env.DB))],
    [Tokens.NotificationDAO, () => Promise.resolve(new NotificationDAO(env.DB))],
    [Tokens.WebhookDAO, () => Promise.resolve(new WebhookDAO(env.DB))],
    [Tokens.WebhookDeliveryDAO, () => Promise.resolve(new WebhookDeliveryDAO(env.DB))],
    [Tokens.ReleaseDAO, () => Promise.resolve(new ReleaseDAO(env.DB))],
    [Tokens.ProjectDAO, () => Promise.resolve(new ProjectDAO(env.DB))],
    [Tokens.DiscussionDAO, () => Promise.resolve(new DiscussionDAO(env.DB))],
    [Tokens.WikiDAO, () => Promise.resolve(new WikiDAO(env.DB))],
    [Tokens.SnippetDAO, () => Promise.resolve(new SnippetDAO(env.DB))],
    [Tokens.TeamDAO, () => Promise.resolve(new TeamDAO(env.DB))],
    [Tokens.TeamMemberDAO, () => Promise.resolve(new TeamMemberDAO(env.DB))],
    [Tokens.TeamRepoGrantDAO, () => Promise.resolve(new TeamRepoGrantDAO(env.DB))],
    [Tokens.AuditLogDAO, () => Promise.resolve(new AuditLogDAO(env.DB))],
    [Tokens.ImportDAO, () => Promise.resolve(new ImportDAO(env.DB))],
    [Tokens.MirrorDAO, () => Promise.resolve(new MirrorDAO(env.DB))],
    [Tokens.DeployKeyDAO, () => Promise.resolve(new DeployKeyDAO(env.DB))],
    [Tokens.TokenRepoGrantDAO, () => Promise.resolve(new TokenRepoGrantDAO(env.DB))],
    [Tokens.SecuritySettingsDAO, () => Promise.resolve(new SecuritySettingsDAO(env.DB))],
  ];
  for (const [token, create] of daoDefs) {
    scope.bindValue(token, memoizeAsync(create));
  }
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
  scope.bind(Tokens.IssueService, () => createService(IssueService, env, { issueDAO }));
  scope.bind(Tokens.PullRequestService, () => createService(PullRequestService, env, { pullRequestDAO }));
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
  scope.bind(Tokens.AuditService, () => createService(AuditService, env, { auditLogDAO, organizationDAO, organizationMemberDAO }));
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
  scope.bind(Tokens.ProjectService, () => createService(ProjectService, env, { projectDAO }));
  scope.bind(Tokens.DiscussionService, () => createService(DiscussionService, env, { discussionDAO }));
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

  return scope;
}

export { createRequestScope };
export type { RequestKeys, RequestScopeEnv };
