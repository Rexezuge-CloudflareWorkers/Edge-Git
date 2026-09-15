import { IssueDAO } from '@edge-git/backend-data/dao';
import type { IssueRow } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { TimestampUtil, UUIDUtil } from '@edge-git/shared/utils';

interface IssueServiceEnv {
  DB: D1Queryable;
}

class IssueService {
  constructor(private readonly env: IssueServiceEnv) {}

  public async listByRepo(repositoryId: string, limit = 50): Promise<IssueRow[]> {
    return new IssueDAO(this.env.DB).listByRepo(repositoryId, limit);
  }

  public async createIssue(input: {
    repositoryId: string;
    fullName: string;
    title: string;
    body?: string | null;
    creatorEmail: string;
  }): Promise<{ id: string; number: number }> {
    const dao = new IssueDAO(this.env.DB);
    const number = await dao.nextNumber(input.repositoryId);
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const id = UUIDUtil.getRandomUUID();
    await dao.create({
      id,
      repositoryId: input.repositoryId,
      fullName: input.fullName,
      number,
      title: input.title,
      body: input.body ?? null,
      creatorEmail: input.creatorEmail,
      now,
    });
    return { id, number };
  }
}

class IssueServiceFactory {
  public static create(env: IssueServiceEnv): IssueService {
    return new IssueService(env);
  }
}

export { IssueService, IssueServiceFactory };
export type { IssueServiceEnv };
