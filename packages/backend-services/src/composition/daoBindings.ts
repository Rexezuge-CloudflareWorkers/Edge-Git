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
  UserEmailDAO,
  WikiDAO,
} from '@edge-git/backend-data/dao';
import {
  AuditLogDAO,
  CheckRunDAO,
  DeletedRepoDoDAO,
  DeployKeyDAO,
  EventDAO,
  ImportDAO,
  MirrorDAO,
  NotificationDAO,
  NumberingDAO,
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
import { Container, memoizeAsync } from '@edge-git/backend-runtime/di';
import type { Token } from '@edge-git/backend-runtime/di';
import { Tokens } from './tokens';
import type { RequestScopeEnv } from './serviceFactory';

// Table-driven DAO wiring (Otter pattern). Each entry is keyed by its typed
// `Tokens.X` symbol directly — no stringly-typed lookup table and no
// `(Tokens as Record<...>)` cast. Each factory thunk is lazy + memoized via
// `memoizeAsync` so `createRequestScope` never touches a DAO constructor
// eagerly: unit tests with partial `vi.mock('@edge-git/backend-data/dao')`
// modules keep working; only the DAOs a test actually resolves are built.
// D1 objects are cheap, but Secrets Store round-trips (via the per-feature
// key thunks) are not: each encrypted DAO resolves only its own key, so a
// webhook-only request never fetches the mirror/import keys.
function bindDaoBindings(scope: Container, env: RequestScopeEnv): void {
  const webhookKey = scope.get(Tokens.WebhookKey);
  const mirrorKey = scope.get(Tokens.MirrorKey);
  const importKey = scope.get(Tokens.ImportKey);
  // The invocation's subrequest counter. Every DAO below is constructed with
  // it, so the kit's `BaseDAO` charges this invocation's statements against
  // one counter rather than the unmetered default — a DAO that charges
  // nothing under-reports silently, and the ceiling never sees the spend.
  const meter = scope.get(Tokens.SubrequestMeter);
  // Encrypted DAOs fail closed: a missing binding throws from the key thunk
  // (no plaintext fallback since 0027 dropped the plaintext columns).
  const webhookDAO = async (): Promise<unknown> => new WebhookDAO(env.DB, await webhookKey(), meter);
  const mirrorDAO = async (): Promise<unknown> => new MirrorDAO(env.DB, await mirrorKey(), meter);
  const importDAO = async (): Promise<unknown> => new ImportDAO(env.DB, await importKey(), meter);
  const daoDefs: Array<[Token<() => Promise<unknown>>, () => Promise<unknown>]> = [
    [Tokens.UserDAO, () => Promise.resolve(new UserDAO(env.DB, meter))],
    [Tokens.UserEmailDAO, () => Promise.resolve(new UserEmailDAO(env.DB, meter))],
    [Tokens.RepositoryDAO, () => Promise.resolve(new RepositoryDAO(env.DB, meter))],
    [Tokens.UserAccessTokenDAO, () => Promise.resolve(new UserAccessTokenDAO(env.DB, meter))],
    [Tokens.IssueDAO, () => Promise.resolve(new IssueDAO(env.DB, meter))],
    [Tokens.PullRequestDAO, () => Promise.resolve(new PullRequestDAO(env.DB, meter))],
    [Tokens.PullThreadDAO, () => Promise.resolve(new PullThreadDAO(env.DB, meter))],
    [Tokens.NamespaceDAO, () => Promise.resolve(new NamespaceDAO(env.DB, meter))],
    [Tokens.NumberingDAO, () => Promise.resolve(new NumberingDAO(env.DB, meter))],
    [Tokens.OrganizationDAO, () => Promise.resolve(new OrganizationDAO(env.DB, meter))],
    [Tokens.OrganizationMemberDAO, () => Promise.resolve(new OrganizationMemberDAO(env.DB, meter))],
    [Tokens.RepoCollaboratorDAO, () => Promise.resolve(new RepoCollaboratorDAO(env.DB, meter))],
    [Tokens.BranchProtectionDAO, () => Promise.resolve(new BranchProtectionDAO(env.DB, meter))],
    [Tokens.CheckRunDAO, () => Promise.resolve(new CheckRunDAO(env.DB, meter))],
    [Tokens.CollaborationDAO, () => Promise.resolve(new CollaborationDAO(env.DB, meter))],
    [Tokens.SearchDAO, () => Promise.resolve(new SearchDAO(env.DB, meter))],
    [Tokens.StarDAO, () => Promise.resolve(new StarDAO(env.DB, meter))],
    [Tokens.WatchDAO, () => Promise.resolve(new WatchDAO(env.DB, meter))],
    [Tokens.EventDAO, () => Promise.resolve(new EventDAO(env.DB, meter))],
    [Tokens.NotificationDAO, () => Promise.resolve(new NotificationDAO(env.DB, meter))],
    [Tokens.WebhookDAO, webhookDAO],
    [Tokens.WebhookDeliveryDAO, () => Promise.resolve(new WebhookDeliveryDAO(env.DB, meter))],
    [Tokens.ReleaseDAO, () => Promise.resolve(new ReleaseDAO(env.DB, meter))],
    [Tokens.ProjectDAO, () => Promise.resolve(new ProjectDAO(env.DB, meter))],
    [Tokens.DiscussionDAO, () => Promise.resolve(new DiscussionDAO(env.DB, meter))],
    [Tokens.WikiDAO, () => Promise.resolve(new WikiDAO(env.DB, meter))],
    [Tokens.SnippetDAO, () => Promise.resolve(new SnippetDAO(env.DB, meter))],
    [Tokens.TeamDAO, () => Promise.resolve(new TeamDAO(env.DB, meter))],
    [Tokens.TeamMemberDAO, () => Promise.resolve(new TeamMemberDAO(env.DB, meter))],
    [Tokens.TeamRepoGrantDAO, () => Promise.resolve(new TeamRepoGrantDAO(env.DB, meter))],
    [Tokens.AuditLogDAO, () => Promise.resolve(new AuditLogDAO(env.DB, meter))],
    [Tokens.ImportDAO, importDAO],
    [Tokens.MirrorDAO, mirrorDAO],
    [Tokens.DeployKeyDAO, () => Promise.resolve(new DeployKeyDAO(env.DB, meter))],
    [Tokens.DeletedRepoDoDAO, () => Promise.resolve(new DeletedRepoDoDAO(env.DB, meter))],
    [Tokens.TokenRepoGrantDAO, () => Promise.resolve(new TokenRepoGrantDAO(env.DB, meter))],
    [Tokens.SecuritySettingsDAO, () => Promise.resolve(new SecuritySettingsDAO(env.DB, meter))],
  ];
  for (const [token, create] of daoDefs) {
    scope.bindValue(token, memoizeAsync(create));
  }
}

export { bindDaoBindings };
