import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Container } from '@edge-git/backend-runtime/di';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { IssueService } from '@edge-git/backend-services/issue';

// Otter mock pattern: hoisted shared vi.fn refs exposed through the mocked
// `@edge-git/backend-data/dao` module. `vi.mock` factories cannot reference
// top-level bindings, hence `vi.hoisted`.
const daoMocks = vi.hoisted(() => ({
  UserDAO: vi.fn(),
  RepositoryDAO: vi.fn(),
  UserAccessTokenDAO: vi.fn(),
  IssueDAO: vi.fn(),
  NamespaceDAO: vi.fn(),
  OrganizationDAO: vi.fn(),
  OrganizationMemberDAO: vi.fn(),
  RepoCollaboratorDAO: vi.fn(),
}));

vi.mock('@edge-git/backend-data/dao', () => ({
  UserDAO: daoMocks.UserDAO,
  RepositoryDAO: daoMocks.RepositoryDAO,
  UserAccessTokenDAO: daoMocks.UserAccessTokenDAO,
  IssueDAO: daoMocks.IssueDAO,
  NamespaceDAO: daoMocks.NamespaceDAO,
  OrganizationDAO: daoMocks.OrganizationDAO,
  OrganizationMemberDAO: daoMocks.OrganizationMemberDAO,
  RepoCollaboratorDAO: daoMocks.RepoCollaboratorDAO,
}));

const EXPECTED_TOKENS = [
  'Env',
  'Db',
  'Keys',
  'AppConfig',
  'UserDAO',
  'RepositoryDAO',
  'UserAccessTokenDAO',
  'IssueDAO',
  'NamespaceDAO',
  'OrganizationDAO',
  'OrganizationMemberDAO',
  'RepoCollaboratorDAO',
  'AccessAuthService',
  'TokenService',
  'RepoService',
  'UserService',
  'IssueService',
  'OrganizationService',
  'PermissionService',
] as const;

function makeEnv() {
  return {
    DB: {},
    SITE_URL: 'https://git.example.com/',
    AES_ENCRYPTION_KEY_SECRET: { get: vi.fn().mockResolvedValue('master-key') },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // NOTE: `function` (not arrow) implementations — requestScope.ts builds DAOs
  // via `new UserDAO(db)`, and arrow functions are not constructible.
  daoMocks.UserDAO.mockImplementation(function (this: unknown, db: unknown) {
    return { kind: 'UserDAO', db };
  });
  daoMocks.RepositoryDAO.mockImplementation(function (this: unknown, db: unknown) {
    return { kind: 'RepositoryDAO', db };
  });
  daoMocks.UserAccessTokenDAO.mockImplementation(function (this: unknown, db: unknown) {
    return { kind: 'UserAccessTokenDAO', db };
  });
  daoMocks.IssueDAO.mockImplementation(function (this: unknown, db: unknown) {
    return { kind: 'IssueDAO', db };
  });
  daoMocks.NamespaceDAO.mockImplementation(function (this: unknown, db: unknown) {
    return { kind: 'NamespaceDAO', db };
  });
  daoMocks.OrganizationDAO.mockImplementation(function (this: unknown, db: unknown) {
    return { kind: 'OrganizationDAO', db };
  });
  daoMocks.OrganizationMemberDAO.mockImplementation(function (this: unknown, db: unknown) {
    return { kind: 'OrganizationMemberDAO', db };
  });
  daoMocks.RepoCollaboratorDAO.mockImplementation(function (this: unknown, db: unknown) {
    return { kind: 'RepoCollaboratorDAO', db };
  });
});

describe('Tokens registry', () => {
  it('exposes one distinct symbol per binding', () => {
    for (const key of EXPECTED_TOKENS) {
      expect(typeof Tokens[key]).toBe('symbol');
    }
    expect(new Set(EXPECTED_TOKENS.map((key) => Tokens[key])).size).toBe(EXPECTED_TOKENS.length);
  });

  it('binds every token in a fresh request scope', () => {
    const scope = createRequestScope(makeEnv() as never);
    for (const key of EXPECTED_TOKENS) {
      expect(scope.has(Tokens[key])).toBe(true);
    }
  });
});

describe('createRequestScope', () => {
  it('shares Env/Db values and memoizes services per scope', () => {
    const env = makeEnv();
    const scope = createRequestScope(env as never);
    expect(scope).toBeInstanceOf(Container);
    expect(scope.get(Tokens.Env)).toBe(env);
    expect(scope.get(Tokens.Db)).toBe(env.DB);
    expect(scope.get(Tokens.RepoService)).toBe(scope.get(Tokens.RepoService));
    expect(scope.get(Tokens.RepoService)).toBeInstanceOf(RepoService);
    expect(scope.get(Tokens.IssueService)).toBeInstanceOf(IssueService);
  });

  it('isolates singletons between scopes', () => {
    const env = makeEnv() as never;
    const first = createRequestScope(env);
    const second = createRequestScope(env);
    expect(first).not.toBe(second);
    expect(first.get(Tokens.RepoService)).not.toBe(second.get(Tokens.RepoService));
  });

  it('memoizes DAO factories so each DAO is constructed once', async () => {
    const scope = createRequestScope(makeEnv() as never);
    const pairs = [
      [Tokens.UserDAO, daoMocks.UserDAO],
      [Tokens.RepositoryDAO, daoMocks.RepositoryDAO],
      [Tokens.UserAccessTokenDAO, daoMocks.UserAccessTokenDAO],
      [Tokens.IssueDAO, daoMocks.IssueDAO],
      [Tokens.NamespaceDAO, daoMocks.NamespaceDAO],
      [Tokens.OrganizationDAO, daoMocks.OrganizationDAO],
      [Tokens.OrganizationMemberDAO, daoMocks.OrganizationMemberDAO],
      [Tokens.RepoCollaboratorDAO, daoMocks.RepoCollaboratorDAO],
    ] as const;
    for (const [token, ctor] of pairs) {
      const factory = scope.get(token);
      const first = await factory();
      await expect(factory()).resolves.toBe(first);
      expect(ctor).toHaveBeenCalledTimes(1);
    }
  });

  it('resolves keys lazily and memoizes the secret fetch', async () => {
    const env = makeEnv();
    const scope = createRequestScope(env as never);
    expect(env.AES_ENCRYPTION_KEY_SECRET.get).not.toHaveBeenCalled();
    const keys = scope.get(Tokens.Keys);
    const first = await keys();
    expect(first).toEqual({ masterKey: 'master-key' });
    await expect(keys()).resolves.toBe(first);
    expect(env.AES_ENCRYPTION_KEY_SECRET.get).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error when the AES secret binding is missing', async () => {
    const { AES_ENCRYPTION_KEY_SECRET: _dropped, ...env } = makeEnv();
    void _dropped;
    const scope = createRequestScope(env as never);
    await expect(scope.get(Tokens.Keys)()).rejects.toThrow('AES_ENCRYPTION_KEY_SECRET');
  });

  it('resolves AppConfig from the request env', () => {
    const scope = createRequestScope(makeEnv() as never);
    expect(scope.get(Tokens.AppConfig).getSiteUrl()).toBe('https://git.example.com');
  });
});

describe('constructor-injected DAO overrides', () => {
  it('RepoService uses the injected repository DAO instead of constructing one', async () => {
    const row = { id: 'r1', owner: 'alice', name: 'demo' };
    const fakeRepositoryDAO = { getByOwnerAndName: vi.fn().mockResolvedValue(row) };
    const svc = new RepoService({ DB: {} } as never, { repositoryDAO: async () => fakeRepositoryDAO as never });
    await expect(svc.getByOwnerAndName('alice', 'demo')).resolves.toBe(row);
    expect(fakeRepositoryDAO.getByOwnerAndName).toHaveBeenCalledWith('alice', 'demo');
    expect(daoMocks.RepositoryDAO).not.toHaveBeenCalled();
  });

  it('IssueService uses the injected issue DAO instead of constructing one', async () => {
    const issues = [{ id: 'i1', number: 1, title: 'Bug' }];
    const fakeIssueDAO = { listByRepo: vi.fn().mockResolvedValue(issues) };
    const svc = new IssueService({ DB: {} } as never, { issueDAO: async () => fakeIssueDAO as never });
    await expect(svc.listByRepo('r1')).resolves.toBe(issues);
    expect(fakeIssueDAO.listByRepo).toHaveBeenCalledWith('r1', 50);
    expect(daoMocks.IssueDAO).not.toHaveBeenCalled();
  });
});
