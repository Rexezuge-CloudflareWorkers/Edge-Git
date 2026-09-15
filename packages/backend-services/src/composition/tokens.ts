import type { IssueDAO, RepositoryDAO, UserAccessTokenDAO, UserDAO } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import type { Token } from '@edge-git/backend-runtime/di';
import type { AppConfiguration } from '@edge-git/backend-runtime/config';
import type { AccessAuthService } from '../auth/AccessAuthService';
import type { TokenService } from '../auth/TokenService';
import type { RepoService } from '../repo/RepoService';
import type { UserService } from '../user/UserService';
import type { IssueService } from '../issue/IssueService';

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
  AccessAuthService: Symbol('AccessAuthService') as Token<AccessAuthService>,
  TokenService: Symbol('TokenService') as Token<TokenService>,
  RepoService: Symbol('RepoService') as Token<RepoService>,
  UserService: Symbol('UserService') as Token<UserService>,
  IssueService: Symbol('IssueService') as Token<IssueService>,
} satisfies Record<string, Token<unknown>>;

export { Tokens };
