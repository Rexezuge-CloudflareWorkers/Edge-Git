import type {
  IssueDAO,
  NamespaceDAO,
  OrganizationDAO,
  OrganizationMemberDAO,
  PullRequestDAO,
  RepoCollaboratorDAO,
  RepositoryDAO,
  UserAccessTokenDAO,
  UserDAO,
} from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import type { Token } from '@edge-git/backend-runtime/di';
import type { AppConfiguration } from '@edge-git/backend-runtime/config';
import type { AccessAuthService } from '../auth/AccessAuthService';
import type { TokenService } from '../auth/TokenService';
import type { ForkService } from '../fork/ForkService';
import type { RepoService } from '../repo/RepoService';
import type { UserService } from '../user/UserService';
import type { IssueService } from '../issue/IssueService';
import type { PullRequestService } from '../pull/PullRequestService';
import type { OrganizationService } from '../org/OrganizationService';
import type { PermissionService } from '../permission/PermissionService';
import type { SearchService } from '../search/SearchService';
import type { SearchDAO } from '@edge-git/backend-data/dao';

// Central token registry for the per-request composition root
// (`requestScope.ts`). Call sites resolve services via
// `scope.get(Tokens.RepoService)` instead of `new X(env)`.
//
// Tokens carry their value type (`Token<T>`) so `scope.get(...)` infers the
// service type without an explicit generic at call sites.
interface RequestScopeEnvShape {
  DB: D1Queryable;
  AES_ENCRYPTION_KEY_SECRET?: { get(): Promise<string> };
}

interface RequestKeysShape {
  masterKey: string;
}

const Tokens = {
  Env: Symbol('Env') as Token<RequestScopeEnvShape>,
  Db: Symbol('Db') as Token<D1Queryable>,
  Keys: Symbol('Keys') as Token<() => Promise<RequestKeysShape>>,
  AppConfig: Symbol('AppConfig') as Token<AppConfiguration>,
  UserDAO: Symbol('UserDAO') as Token<() => Promise<UserDAO>>,
  RepositoryDAO: Symbol('RepositoryDAO') as Token<() => Promise<RepositoryDAO>>,
  UserAccessTokenDAO: Symbol('UserAccessTokenDAO') as Token<() => Promise<UserAccessTokenDAO>>,
  IssueDAO: Symbol('IssueDAO') as Token<() => Promise<IssueDAO>>,
  PullRequestDAO: Symbol('PullRequestDAO') as Token<() => Promise<PullRequestDAO>>,
  NamespaceDAO: Symbol('NamespaceDAO') as Token<() => Promise<NamespaceDAO>>,
  OrganizationDAO: Symbol('OrganizationDAO') as Token<() => Promise<OrganizationDAO>>,
  OrganizationMemberDAO: Symbol('OrganizationMemberDAO') as Token<() => Promise<OrganizationMemberDAO>>,
  RepoCollaboratorDAO: Symbol('RepoCollaboratorDAO') as Token<() => Promise<RepoCollaboratorDAO>>,
  SearchDAO: Symbol('SearchDAO') as Token<() => Promise<SearchDAO>>,
  AccessAuthService: Symbol('AccessAuthService') as Token<AccessAuthService>,
  TokenService: Symbol('TokenService') as Token<TokenService>,
  ForkService: Symbol('ForkService') as Token<ForkService>,
  RepoService: Symbol('RepoService') as Token<RepoService>,
  UserService: Symbol('UserService') as Token<UserService>,
  IssueService: Symbol('IssueService') as Token<IssueService>,
  PullRequestService: Symbol('PullRequestService') as Token<PullRequestService>,
  OrganizationService: Symbol('OrganizationService') as Token<OrganizationService>,
  PermissionService: Symbol('PermissionService') as Token<PermissionService>,
  SearchService: Symbol('SearchService') as Token<SearchService>,
} satisfies Record<string, Token<unknown>>;

export { Tokens };
