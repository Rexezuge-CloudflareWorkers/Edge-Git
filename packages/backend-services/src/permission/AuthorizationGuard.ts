import type { RepositoryRow } from '@edge-git/backend-data/dao';
import type { RepoPermission } from './PermissionService';

interface IAuthorizationGuard {
  requireVisible(
    viewerEmail: string | null,
    repo: RepositoryRow | null,
  ): Promise<RepositoryRow | null>;
  requireRole(
    viewerEmail: string | null,
    repo: RepositoryRow | null,
    minimum: RepoPermission,
  ): Promise<{ row: RepositoryRow; role: RepoPermission } | null>;
}

export type { IAuthorizationGuard };
