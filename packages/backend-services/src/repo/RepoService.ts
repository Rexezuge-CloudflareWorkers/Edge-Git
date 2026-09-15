import { RepositoryDAO } from '@edge-git/backend-data/dao';
import type { RepositoryRow } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError, ForbiddenError, NotFoundError } from '@edge-git/backend-errors';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { TimestampUtil, UUIDUtil } from '@edge-git/shared/utils';

interface RepoServiceEnv {
  DB: D1Queryable;
  MAX_REPOS_PER_USER?: string;
}

const OWNER_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const REPO_RE = /^[a-z0-9._-]{1,100}$/i;

class RepoService {
  constructor(private readonly env: RepoServiceEnv) {}

  public static normalizeOwner(owner: string): string {
    return owner.trim();
  }

  public static normalizeRepo(name: string): string {
    const n = name.trim();
    return n.endsWith('.git') ? n.slice(0, -4) : n;
  }

  public static validateNames(owner: string, name: string): void {
    if (!OWNER_RE.test(owner) || !REPO_RE.test(name)) {
      throw new BadRequestError('Invalid owner or repository name');
    }
  }

  public async createRepo(userEmail: string, owner: string, name: string, description: string | null, isPrivate: boolean): Promise<{ id: string }> {
    const dao = new RepositoryDAO(this.env.DB);
    RepoService.validateNames(owner, name);
    const existing = await dao.getByOwnerAndName(owner, name);
    if (existing) {
      throw new BadRequestError('Repository already exists');
    }
    const owned = await dao.listByOwnerEmail(userEmail, 1000);
    const max = ConfigurationManager.repo.getMaxPerUser(this.env);
    if (owned.length >= max) {
      throw new BadRequestError(`Maximum ${max} repositories per user`);
    }
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const id = UUIDUtil.getRandomUUID();
    await dao.create({ id, ownerEmail: userEmail, owner, name, description, isPrivate, now });
    return { id };
  }

  public async getRepo(owner: string, name: string): Promise<RepositoryRow | null> {
    const dao = new RepositoryDAO(this.env.DB);
    return dao.getByOwnerAndName(owner, name);
  }

  public async getByOwnerAndName(owner: string, name: string): Promise<RepositoryRow | null> {
    return this.getRepo(owner, name);
  }

  public async listByOwnerEmail(ownerEmail: string, limit = 100): Promise<RepositoryRow[]> {
    return new RepositoryDAO(this.env.DB).listByOwnerEmail(ownerEmail, limit);
  }

  public async requireOwner(owner: string, name: string, userEmail: string): Promise<RepositoryRow> {
    const dao = new RepositoryDAO(this.env.DB);
    const repo = await dao.getByOwnerAndName(owner, name);
    if (!repo) {
      throw new NotFoundError('Repository not found');
    }
    if (repo.owner_email !== userEmail) {
      throw new ForbiddenError('Only the repository owner can perform this action');
    }
    return repo;
  }
}

class RepoServiceFactory {
  public static create(env: RepoServiceEnv): RepoService {
    return new RepoService(env);
  }
}

export { RepoService, RepoServiceFactory };
export type { RepoServiceEnv };
