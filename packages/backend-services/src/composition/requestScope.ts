import { BranchProtectionDAO, CollaborationDAO, DiscussionDAO, IssueDAO, NamespaceDAO, OrganizationDAO, OrganizationMemberDAO, ProjectDAO, PullRequestDAO, PullThreadDAO, ReleaseDAO, RepoCollaboratorDAO, RepositoryDAO, SearchDAO, SnippetDAO, UserAccessTokenDAO, UserDAO, WikiDAO } from '@edge-git/backend-data/dao';
import { EventDAO, NotificationDAO, StarDAO, WatchDAO, WebhookDAO, WebhookDeliveryDAO } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { Container } from '@edge-git/backend-runtime/di';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
// NOTE: service imports use the package entry points (`@edge-git/...`)
// rather than relative file paths so route unit tests mocking those modules
// (`vi.mock('@edge-git/backend-services/repo', ...)`) keep working
// after migration to `scope.get(...)`. Runtime behavior is identical.
import { AccessAuthService, TokenService } from '@edge-git/backend-services/auth';
import { BranchProtectionService } from '@edge-git/backend-services/protection';
import { ForkService } from '@edge-git/backend-services/fork';
import { RepoService } from '@edge-git/backend-services/repo';
import { UserService } from '@edge-git/backend-services/user';
import { IssueService } from '@edge-git/backend-services/issue';
import { PullRequestService } from '@edge-git/backend-services/pull';
import { PullThreadService } from '@edge-git/backend-services/pull/PullThreadService';
import { OrganizationService } from '@edge-git/backend-services/org';
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
import { SnippetService } from '@edge-git/backend-services/snippet';
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

function memoize<T>(fn: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= fn());
}

// Composition root: builds a per-request child scope wiring DAOs → services.
// Replaces the former scattered `new X(env)` / `new XDAO(env.DB)`
// call sites in apps/api and apps/background.
function createRequestScope(env: RequestScopeEnv): Container {
  const scope = new Container();
  scope.bindValue(Tokens.Env, env);
  scope.bindValue(Tokens.Db, env.DB);

  const masterKey = memoize(() => {
    if (!env.AES_ENCRYPTION_KEY_SECRET) throw new Error('AES_ENCRYPTION_KEY_SECRET is not configured for this scope.');
    return env.AES_ENCRYPTION_KEY_SECRET.get();
  });
  const keys = memoize(async (): Promise<RequestKeys> => ({ masterKey: await masterKey() }));
  scope.bindValue(Tokens.Keys, keys);

  const userDAO = memoize(() => Promise.resolve(new UserDAO(env.DB)));
  const repositoryDAO = memoize(() => Promise.resolve(new RepositoryDAO(env.DB)));
  const tokenDAO = memoize(() => Promise.resolve(new UserAccessTokenDAO(env.DB)));
  const issueDAO = memoize(() => Promise.resolve(new IssueDAO(env.DB)));
  const pullRequestDAO = memoize(() => Promise.resolve(new PullRequestDAO(env.DB)));
  const pullThreadDAO = memoize(() => Promise.resolve(new PullThreadDAO(env.DB)));
  const namespaceDAO = memoize(() => Promise.resolve(new NamespaceDAO(env.DB)));
  const organizationDAO = memoize(() => Promise.resolve(new OrganizationDAO(env.DB)));
  const organizationMemberDAO = memoize(() => Promise.resolve(new OrganizationMemberDAO(env.DB)));
  const repoCollaboratorDAO = memoize(() => Promise.resolve(new RepoCollaboratorDAO(env.DB)));
  const branchProtectionDAO = memoize(() => Promise.resolve(new BranchProtectionDAO(env.DB)));
  const collaborationDAO = memoize(() => Promise.resolve(new CollaborationDAO(env.DB)));
  const searchDAO = memoize(() => Promise.resolve(new SearchDAO(env.DB)));
  const starDAO = memoize(() => Promise.resolve(new StarDAO(env.DB)));
  const watchDAO = memoize(() => Promise.resolve(new WatchDAO(env.DB)));
  const eventDAO = memoize(() => Promise.resolve(new EventDAO(env.DB)));
  const notificationDAO = memoize(() => Promise.resolve(new NotificationDAO(env.DB)));
  const webhookDAO = memoize(() => Promise.resolve(new WebhookDAO(env.DB)));
  const webhookDeliveryDAO = memoize(() => Promise.resolve(new WebhookDeliveryDAO(env.DB)));
  const releaseDAO = memoize(() => Promise.resolve(new ReleaseDAO(env.DB)));
  const projectDAO = memoize(() => Promise.resolve(new ProjectDAO(env.DB)));
  const discussionDAO = memoize(() => Promise.resolve(new DiscussionDAO(env.DB)));
  const wikiDAO = memoize(() => Promise.resolve(new WikiDAO(env.DB)));
  const snippetDAO = memoize(() => Promise.resolve(new SnippetDAO(env.DB)));
  scope.bindValue(Tokens.UserDAO, userDAO);
  scope.bindValue(Tokens.RepositoryDAO, repositoryDAO);
  scope.bindValue(Tokens.UserAccessTokenDAO, tokenDAO);
  scope.bindValue(Tokens.IssueDAO, issueDAO);
  scope.bindValue(Tokens.PullRequestDAO, pullRequestDAO);
  scope.bindValue(Tokens.PullThreadDAO, pullThreadDAO);
  scope.bindValue(Tokens.NamespaceDAO, namespaceDAO);
  scope.bindValue(Tokens.OrganizationDAO, organizationDAO);
  scope.bindValue(Tokens.OrganizationMemberDAO, organizationMemberDAO);
  scope.bindValue(Tokens.RepoCollaboratorDAO, repoCollaboratorDAO);
  scope.bindValue(Tokens.BranchProtectionDAO, branchProtectionDAO);
  scope.bindValue(Tokens.CollaborationDAO, collaborationDAO);
  scope.bindValue(Tokens.SearchDAO, searchDAO);
  scope.bindValue(Tokens.StarDAO, starDAO);
  scope.bindValue(Tokens.WatchDAO, watchDAO);
  scope.bindValue(Tokens.EventDAO, eventDAO);
  scope.bindValue(Tokens.NotificationDAO, notificationDAO);
  scope.bindValue(Tokens.WebhookDAO, webhookDAO);
  scope.bindValue(Tokens.WebhookDeliveryDAO, webhookDeliveryDAO);
  scope.bindValue(Tokens.ReleaseDAO, releaseDAO);
  scope.bindValue(Tokens.ProjectDAO, projectDAO);
  scope.bindValue(Tokens.DiscussionDAO, discussionDAO);
  scope.bindValue(Tokens.WikiDAO, wikiDAO);
  scope.bindValue(Tokens.SnippetDAO, snippetDAO);

  scope.bind(Tokens.AccessAuthService, () => new AccessAuthService(env as never));
  scope.bind(Tokens.TokenService, () => new TokenService(env as never, { tokenDAO }));
  scope.bind(Tokens.BranchProtectionService, () => new BranchProtectionService(env as never, { branchProtectionDAO }));
  scope.bind(
    Tokens.ForkService,
    () => new ForkService(env as never, { repositoryDAO, userDAO, organizationDAO, organizationMemberDAO, repoCollaboratorDAO, namespaceDAO }),
  );
  scope.bind(
    Tokens.RepoService,
    () => new RepoService(env as never, { repositoryDAO, issueDAO, pullRequestDAO, pullThreadDAO, branchProtectionDAO, userDAO, organizationDAO, organizationMemberDAO, repoCollaboratorDAO, namespaceDAO, starDAO, watchDAO, eventDAO, notificationDAO, releaseDAO, projectDAO, discussionDAO, wikiDAO }),
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
    Tokens.PermissionService,
    () => new PermissionService(env as never, { organizationDAO, organizationMemberDAO, repoCollaboratorDAO, namespaceDAO }),
  );
  scope.bind(
    Tokens.SearchService,
    () =>
      new SearchService(env as never, {
        searchDAO,
        repositoryDAO,
        issueDAO,
        permissionService: () =>
          Promise.resolve(
            new PermissionService(env as never, { organizationDAO, organizationMemberDAO, repoCollaboratorDAO, namespaceDAO }),
          ),
      }),
  );
  scope.bind(Tokens.StarService, () => new StarService(env as never, { starDAO }));
  scope.bind(Tokens.CollaborationService, () => new CollaborationService(env as never, { collaborationDAO }));
  scope.bind(Tokens.ReleaseService, () => new ReleaseService(env as never, { releaseDAO }));
  scope.bind(Tokens.ProjectService, () => new ProjectService(env as never, { projectDAO }));
  scope.bind(Tokens.DiscussionService, () => new DiscussionService(env as never, { discussionDAO }));
  scope.bind(Tokens.WikiService, () => new WikiService(env as never, { wikiDAO }));
  scope.bind(Tokens.SnippetService, () => new SnippetService(env as never, { snippetDAO }));
  scope.bind(Tokens.WatchService, () => new WatchService(env as never, { watchDAO }));
  scope.bind(Tokens.ActivityService, () => new ActivityService(env as never, { eventDAO }));
  scope.bind(Tokens.WebhookService, () => new WebhookService(env as never, { webhookDAO }));
  scope.bind(Tokens.WebhookDeliveryService, () => new WebhookDeliveryService(env as never, { webhookDAO, deliveryDAO: webhookDeliveryDAO }));
  scope.bind(
    Tokens.NotificationService,
    () =>
      new NotificationService(env as never, {
        notificationDAO,
        watchDAO,
        userDAO,
        repositoryDAO,
        permissionService: () =>
          Promise.resolve(new PermissionService(env as never, { organizationDAO, organizationMemberDAO, repoCollaboratorDAO, namespaceDAO })),
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
