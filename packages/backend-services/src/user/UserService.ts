import { UserDAO } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { TimestampUtil } from '@edge-git/shared/utils';

interface UserServiceEnv {
  DB: D1Queryable;
}

interface UserServiceDeps {
  userDAO?: () => Promise<UserDAO>;
}

class UserService {
  private readonly deps: Required<UserServiceDeps>;

  constructor(
    private readonly env: UserServiceEnv,
    deps: UserServiceDeps = {},
  ) {
    this.deps = {
      userDAO: () => Promise.resolve(new UserDAO(env.DB)),
      ...deps,
    };
  }

  public async upsertUser(email: string): Promise<void> {
    const dao = await this.deps.userDAO();
    await dao.upsertUser(email.toLowerCase(), TimestampUtil.getCurrentUnixTimestampInSeconds());
  }
}

/**
@deprecated Prefer `createRequestScope(env).get(Tokens.UserService)`; this thin wrapper only preserves backward compatibility.
*/
class UserServiceFactory {
  public static create(env: UserServiceEnv): UserService {
    return new UserService(env);
  }
}

export { UserService, UserServiceFactory };
export type { UserServiceDeps, UserServiceEnv };
