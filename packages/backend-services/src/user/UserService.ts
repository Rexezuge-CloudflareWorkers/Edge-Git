import { UserDAO } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { TimestampUtil } from '@edge-git/shared/utils';

interface UserServiceEnv {
  DB: D1Queryable;
}

class UserService {
  constructor(private readonly env: UserServiceEnv) {}

  public async upsertUser(email: string): Promise<void> {
    const dao = new UserDAO(this.env.DB);
    await dao.upsertUser(email.toLowerCase(), TimestampUtil.getCurrentUnixTimestampInSeconds());
  }
}

class UserServiceFactory {
  public static create(env: UserServiceEnv): UserService {
    return new UserService(env);
  }
}

export { UserService, UserServiceFactory };
export type { UserServiceEnv };
