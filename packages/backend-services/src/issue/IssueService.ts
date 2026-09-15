import { IssueDAO } from '@edge-git/backend-data/dao';
import type { IssueRow } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { TimestampUtil, UUIDUtil } from '@edge-git/shared/utils';

interface IssueServiceEnv {
  DB: D1Queryable;
}

interface IssueServiceDeps {
  issueDAO?: () => Promise<IssueDAO>;
}

class IssueService {
  private readonly deps: Required<IssueServiceDeps>;

  constructor(
    private readonly env: IssueServiceEnv,
    deps: IssueServiceDeps = {},
  ) {
    this.deps = {
      issueDAO: () => Promise.resolve(new IssueDAO(env.DB)),
      ...deps,
    };
  }

  public async listByRepo(repositoryId: string, limit = 50): Promise<IssueRow[]> {
    const dao = await this.deps.issueDAO();
    return dao.listByRepo(repositoryId, limit);
  }

  public async createIssue(input: {
    repositoryId: string;
    fullName: string;
    title: string;
    body?: string | null;
    creatorEmail: string;
  }): Promise<{ id: string; number: number }> {
    const dao = await this.deps.issueDAO();
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

/**
@deprecated Prefer `createRequestScope(env).get(Tokens.IssueService)`; this thin wrapper only preserves backward compatibility.
*/
class IssueServiceFactory {
  public static create(env: IssueServiceEnv): IssueService {
    return new IssueService(env);
  }
}

export { IssueService, IssueServiceFactory };
export type { IssueServiceDeps, IssueServiceEnv };
