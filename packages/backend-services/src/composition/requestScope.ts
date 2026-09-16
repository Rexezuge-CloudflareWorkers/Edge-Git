import { BranchProtectionDAO, IssueDAO, NamespaceDAO, OrganizationDAO, OrganizationMemberDAO, PullRequestDAO, RepoCollaboratorDAO, RepositoryDAO, SearchDAO, UserAccessTokenDAO, UserDAO } from '@edge-git/backend-data/dao';
import { EventDAO, NotificationDAO, StarDAO, WatchDAO } from '@edge-git/backend-data/dao';
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
import { OrganizationService } from '@edge-git/backend-services/org';
import { PermissionService } from '@edge-git/backend-services/permission';
import { SearchService } from '@edge-git/backend-services/search';
import { ActivityService } from '@edge-git/backend-services/social/ActivityService';
import { NotificationService } from '@edge-git/backend-services/social/NotificationService';
import { StarService } from '@edge-git/backend-services/social/StarService';
import { WatchService } from '@edge-git/backend-services/social/WatchService';
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
// Replaces the scattered `*Factory.create({ DB })` / `new XDAO(env.DB)`
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
  const namespaceDAO = memoize(() => Promise.resolve(new NamespaceDAO(env.DB)));
  const organizationDAO = memoize(() => Promise.resolve(new OrganizationDAO(env.DB)));
  const organizationMemberDAO = memoize(() => Promise.resolve(new OrganizationMemberDAO(env.DB)));
  const repoCollaboratorDAO = memoize(() => Promise.resolve(new RepoCollaboratorDAO(env.DB)));
  const branchProtectionDAO = memoize(() => Promise.resolve(new BranchProtectionDAO(env.DB)));
  const searchDAO = memoize(() => Promise.resolve(new SearchDAO(env.DB)));
  const starDAO = memoize(() => Promise.resolve(new StarDAO(env.DB)));
  const watchDAO = memoize(() => Promise.resolve(new WatchDAO(env.DB)));
  const eventDAO = memoize(() => Promise.resolve(new EventDAO(env.DB)));
  const notificationDAO = memoize(() => Promise.resolve(new NotificationDAO(env.DB)));
  scope.bindValue(Tokens.UserDAO, userDAO);
  scope.bindValue(Tokens.RepositoryDAO, repositoryDAO);
  scope.bindValue(Tokens.UserAccessTokenDAO, tokenDAO);
  scope.bindValue(Tokens.IssueDAO, issueDAO);
  scope.bindValue(Tokens.PullRequestDAO, pullRequestDAO);
  scope.bindValue(Tokens.NamespaceDAO, namespaceDAO);
  scope.bindValue(Tokens.OrganizationDAO, organizationDAO);
  scope.bindValue(Tokens.OrganizationMemberDAO, organizationMemberDAO);
  scope.bindValue(Tokens.RepoCollaboratorDAO, repoCollaboratorDAO);
  scope.bindValue(Tokens.BranchProtectionDAO, branchProtectionDAO);
  scope.bindValue(Tokens.SearchDAO, searchDAO);
  scope.bindValue(Tokens.StarDAO, starDAO);
  scope.bindValue(Tokens.WatchDAO, watchDAO);
  scope.bindValue(Tokens.EventDAO, eventDAO);
  scope.bindValue(Tokens.NotificationDAO, notificationDAO);

  scope.bind(Tokens.AccessAuthService, () => new AccessAuthService(env as never));
  scope.bind(Tokens.TokenService, () => new TokenService(env as never, { tokenDAO }));
  scope.bind(Tokens.BranchProtectionService, () => new BranchProtectionService(env as never, { branchProtectionDAO }));
  scope.bind(
    Tokens.ForkService,
    () => new ForkService(env as never, { repositoryDAO, userDAO, organizationDAO, organizationMemberDAO, repoCollaboratorDAO, namespaceDAO }),
  );
  scope.bind(
    Tokens.RepoService,
    () => new RepoService(env as never, { repositoryDAO, issueDAO, pullRequestDAO, branchProtectionDAO, userDAO, organizationDAO, organizationMemberDAO, repoCollaboratorDAO, namespaceDAO, starDAO, watchDAO, eventDAO, notificationDAO }),
  );
  scope.bind(Tokens.UserService, () => new UserService(env as never, { userDAO, namespaceDAO, organizationDAO, repositoryDAO }));
  scope.bind(Tokens.IssueService, () => new IssueService(env as never, { issueDAO }));
  scope.bind(Tokens.PullRequestService, () => new PullRequestService(env as never, { pullRequestDAO }));
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
  scope.bind(Tokens.WatchService, () => new WatchService(env as never, { watchDAO }));
  scope.bind(Tokens.ActivityService, () => new ActivityService(env as never, { eventDAO }));
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
