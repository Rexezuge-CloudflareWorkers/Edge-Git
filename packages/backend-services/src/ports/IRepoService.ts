import type { RepositoryRow, RepoRole } from '@edge-git/backend-data/dao';

interface IRepoService {
  getByOwnerAndName(owner: string, name: string): Promise<RepositoryRow | null>;
  getRole(viewerEmail: string | null, repo: RepositoryRow | null): Promise<RepoRole | null>;
}

export type { IRepoService };
