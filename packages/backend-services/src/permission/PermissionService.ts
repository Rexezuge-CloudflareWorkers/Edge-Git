import type { RepositoryRow } from '@edge-git/backend-data/dao';
import {
  NamespaceDAO,
  OrganizationDAO,
  OrganizationMemberDAO,
  RepoCollaboratorDAO,
  TeamDAO,
  TeamMemberDAO,
  TeamRepoGrantDAO,
} from '@edge-git/backend-data/dao';
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
  teamDAO?: () => Promise<TeamDAO>;
  teamMemberDAO?: () => Promise<TeamMemberDAO>;
  teamGrantDAO?: () => Promise<TeamRepoGrantDAO>;
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
      teamDAO: () => Promise.resolve(new TeamDAO(env.DB)),
      teamMemberDAO: () => Promise.resolve(new TeamMemberDAO(env.DB)),
      teamGrantDAO: () => Promise.resolve(new TeamRepoGrantDAO(env.DB)),
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
      let best: RepoPermission | null = null;
      try {
        const collabDAO = await this.deps.repoCollaboratorDAO();
        const grant = await collabDAO.get(repo.id, viewer);
        if (grant) best = grant.role;
      } catch {
        // ignore
      }
      // Team-derived grants (org repos only): max of direct + team grants.
      // Missing team tables (legacy DBs/fakes) fall through silently.
      try {
        const teamBest = await this.getTeamRole(orgId, repo.id, viewer);
        if (teamBest && (!best || ROLE_RANK[teamBest] > ROLE_RANK[best])) best = teamBest;
      } catch {
        // ignore
      }
      if (best) return best;
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

  /**
   * Best team-derived role for a viewer on an org repo: for every grant on
   * this repo, checks membership in the granting team (scoped to the same
   * org) and returns the max role. Teams never apply to user-owned repos.
   *
   * Batched (Otter `RepositoryHelper` pattern): team rows + membership rows
   * load concurrently with per-request dedup so the git-auth hot path is
   * `1 grant list + 1 fan-out` instead of sequential N+1 round-trips.
   */
  private async getTeamRole(orgId: string, repoId: string, viewer: string): Promise<RepoPermission | null> {
    const grantDAO = await this.deps.teamGrantDAO();
    const grants = await grantDAO.listByRepo(repoId).catch(() => []);
    if (grants.length === 0) return null;
    const memberDAO = await this.deps.teamMemberDAO();
    const teamDAO = await this.deps.teamDAO();
    const uniqueTeamIds = [...new Set(grants.map((g) => g.team_id))];
    const [teams, memberships] = await Promise.all([
      Promise.all(uniqueTeamIds.map((id) => teamDAO.getById(id).catch(() => null))),
      Promise.all(uniqueTeamIds.map((id) => memberDAO.get(id, viewer).catch(() => null))),
    ]);
    const teamById = new Map(
      teams.filter((t): t is NonNullable<typeof t> => t !== null).map((t) => [t.id, t] as const),
    );
    // Positional membership: `memberships[i]` answers `uniqueTeamIds[i]`.
    // (Do not rely on the row's `team_id` field — fakes/legacy rows may omit it.)
    const memberTeamIds = new Set(uniqueTeamIds.filter((_, i) => memberships[i] !== null));
    let best: RepoPermission | null = null;
    for (const grant of grants) {
      const team = teamById.get(grant.team_id);
      if (!team || team.org_id !== orgId) continue;
      if (!memberTeamIds.has(grant.team_id)) continue;
      const role = grant.role;
      if (!best || ROLE_RANK[role] > ROLE_RANK[best]) {
        best = role;
        if (best === 'admin') break;
      }
    }
    return best;
  }
}

export { PermissionService };
export type { PermissionServiceDeps, PermissionServiceEnv, RepoPermission };
