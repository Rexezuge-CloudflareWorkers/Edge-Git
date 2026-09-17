import type { RepositoryRow } from '@edge-git/backend-data/dao';
import { NamespaceDAO, OrganizationDAO, OrganizationMemberDAO, RepoCollaboratorDAO } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import type { RepoRole } from '@edge-git/backend-data/dao';

type RepoPermission = RepoRole;

interface PermissionServiceEnv {
  DB: D1Queryable;
}

interface PermissionServiceDeps {
  organizationDAO?: () => Promise<OrganizationDAO>;
  organizationMemberDAO?: () => Promise<OrganizationMemberDAO>;
  repoCollaboratorDAO?: () => Promise<RepoCollaboratorDAO>;
  namespaceDAO?: () => Promise<NamespaceDAO>;
}

const ROLE_RANK: Record<RepoPermission, number> = { read: 1, write: 2, admin: 3 };

class PermissionService {
  private readonly deps: Required<PermissionServiceDeps>;

  constructor(
    private readonly env: PermissionServiceEnv,
    deps: PermissionServiceDeps = {},
  ) {
    this.deps = {
      organizationDAO: () => Promise.resolve(new OrganizationDAO(env.DB)),
      organizationMemberDAO: () => Promise.resolve(new OrganizationMemberDAO(env.DB)),
      repoCollaboratorDAO: () => Promise.resolve(new RepoCollaboratorDAO(env.DB)),
      namespaceDAO: () => Promise.resolve(new NamespaceDAO(env.DB)),
      ...deps,
    };
  }

  public static rank(role: RepoPermission): number {
    return ROLE_RANK[role];
  }

  public static meets(actual: RepoPermission | null, minimum: RepoPermission): boolean {
    if (!actual) return false;
    return ROLE_RANK[actual] >= ROLE_RANK[minimum];
  }

  private static isPrivateRepo(repo: RepositoryRow): boolean {
    return repo.is_private === 1;
  }

  private static ownerCiOf(repo: RepositoryRow): string {
    return (repo.owner_ci ?? repo.owner).toLowerCase();
  }

  private static ownerTypeOf(repo: RepositoryRow): string {
    if (repo.owner_type) return repo.owner_type;
    if (repo.org_id) return 'org';
    return 'user';
  }

  public async getRole(viewerEmail: string | null, repo: RepositoryRow | null): Promise<RepoPermission | null> {
    if (!repo) return null;
    const isPrivate = PermissionService.isPrivateRepo(repo);
    if (!viewerEmail) return isPrivate ? null : 'read';
    const viewer = viewerEmail.toLowerCase();

    // Resolve org (0002 path with graceful fallback for legacy DBs/fakes).
    let orgId: string | null = null;
    try {
      const ownerType = PermissionService.ownerTypeOf(repo);
      if (ownerType === 'org') {
        if (repo.org_id) {
          orgId = repo.org_id;
        } else {
          const orgDAO = await this.deps.organizationDAO();
          const org = await orgDAO.getByUsernameCi(PermissionService.ownerCiOf(repo));
          if (org) orgId = org.id;
          // owner_type says org but row missing (deleted org): treat as no-access except public read.
          if (!orgId) return isPrivate ? null : 'read';
        }
      } else {
        // User-owned fast path may still be an org repo on legacy rows: check registry once.
        // Namespace lookup is cheap; missing-table errors fall through to user logic.
        try {
          const orgDAO = await this.deps.organizationDAO();
          const maybeOrg = await orgDAO.getByUsernameCi(PermissionService.ownerCiOf(repo));
          if (maybeOrg && (repo.org_id === maybeOrg.id || repo.owner_type === 'org')) orgId = maybeOrg.id;
        } catch {
          // ignore — legacy DB without organizations table
        }
      }
    } catch {
      orgId = null;
    }

    if (orgId) {
      try {
        const memberDAO = await this.deps.organizationMemberDAO();
        const membership = await memberDAO.get(orgId, viewer);
        if (membership?.role === 'owner') return 'admin';
      } catch {
        // missing table → fall through to collaborator/public checks
      }
      try {
        const collabDAO = await this.deps.repoCollaboratorDAO();
        const grant = await collabDAO.get(repo.id, viewer);
        if (grant) return grant.role;
      } catch {
        // ignore
      }
      return isPrivate ? null : 'read';
    }

    // User-owned repo.
    const ownerEmail = repo.owner_user_email ?? repo.owner_email;
    if (ownerEmail?.toLowerCase() === viewer) return 'admin';
    try {
      const collabDAO = await this.deps.repoCollaboratorDAO();
      const grant = await collabDAO.get(repo.id, viewer);
      if (grant) return grant.role;
    } catch {
      // ignore
    }
    return isPrivate ? null : 'read';
  }
}

export { PermissionService };
export type { PermissionServiceDeps, PermissionServiceEnv, RepoPermission };
