import type { RepositoryRow } from '@edge-git/backend-data/dao';
import type { RepoPermission } from '../permission/PermissionService';

interface IPermissionService {
  getRole(viewerEmail: string | null, repo: RepositoryRow | null): Promise<RepoPermission | null>;
}

export type { IPermissionService };
