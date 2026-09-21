import {
  NamespaceDAO,
  OrganizationDAO,
  OrganizationMemberDAO,
  RepoCollaboratorDAO,
  RepositoryDAO,
  UserDAO,
} from '@edge-git/backend-data/dao';
import type { RepositoryRow } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError, NotFoundError } from '@edge-git/backend-errors';
import { EmailAddress, RepoFullName } from '@edge-git/shared/utils';
import { PermissionService } from '../permission/PermissionService';
import { RepoService } from '../repo/RepoService';

interface ForkServiceEnv {
  DB: D1Queryable;
  MAX_REPOS_PER_USER?: string;
}

interface ForkServiceDeps {
  repositoryDAO?: () => Promise<RepositoryDAO>;
  userDAO?: () => Promise<UserDAO>;
  organizationDAO?: () => Promise<OrganizationDAO>;
  organizationMemberDAO?: () => Promise<OrganizationMemberDAO>;
  repoCollaboratorDAO?: () => Promise<RepoCollaboratorDAO>;
  namespaceDAO?: () => Promise<NamespaceDAO>;
  permissionService?: () => Promise<PermissionService>;
}

/**
 * Forks: user-specified destination `{owner, name}` copies of a visible
 * source repo. D1 lineage (`forked_from_*`) is recorded at creation; git
 * object copying is orchestrated by the API layer via DO RPC
 * (`exportPack`/`importPack`) and rolled back on failure.
 */
class ForkService {
  private readonly deps: Required<ForkServiceDeps>;

  constructor(
    private readonly env: ForkServiceEnv,
    deps: ForkServiceDeps = {},
  ) {
    const permissionService =
      deps.permissionService ??
      ((): Promise<PermissionService> =>
        Promise.resolve(
          new PermissionService(this.env, {
            organizationDAO: deps.organizationDAO ?? (() => Promise.resolve(new OrganizationDAO(env.DB))),
            organizationMemberDAO: deps.organizationMemberDAO ?? (() => Promise.resolve(new OrganizationMemberDAO(env.DB))),
            repoCollaboratorDAO: deps.repoCollaboratorDAO ?? (() => Promise.resolve(new RepoCollaboratorDAO(env.DB))),
            namespaceDAO: deps.namespaceDAO ?? (() => Promise.resolve(new NamespaceDAO(env.DB))),
          }),
        ));
    this.deps = {
      repositoryDAO: () => Promise.resolve(new RepositoryDAO(env.DB)),
      userDAO: () => Promise.resolve(new UserDAO(env.DB)),
      organizationDAO: () => Promise.resolve(new OrganizationDAO(env.DB)),
      organizationMemberDAO: () => Promise.resolve(new OrganizationMemberDAO(env.DB)),
      repoCollaboratorDAO: () => Promise.resolve(new RepoCollaboratorDAO(env.DB)),
      namespaceDAO: () => Promise.resolve(new NamespaceDAO(env.DB)),
      permissionService,
      ...deps,
    };
  }

  private repoService(): RepoService {
    return new RepoService(this.env, {
      repositoryDAO: this.deps.repositoryDAO,
      userDAO: this.deps.userDAO,
      organizationDAO: this.deps.organizationDAO,
      organizationMemberDAO: this.deps.organizationMemberDAO,
      repoCollaboratorDAO: this.deps.repoCollaboratorDAO,
      namespaceDAO: this.deps.namespaceDAO,
      permissionService: this.deps.permissionService,
    });
  }

  private permission(): Promise<PermissionService> {
    return this.deps.permissionService();
  }

  private async resolveDefaultOwner(userEmail: string): Promise<string> {
    const normalized = EmailAddress.normalize(userEmail);
    try {
      const userDao = await this.deps.userDAO();
      const user = await userDao.getByEmail(normalized);
      if (user?.username) return user.username;
    } catch {
      // ignore — fall back to email prefix below
    }
    return normalized.split('@', 1)[0] ?? normalized;
  }

  /**
   * Validate the fork request and create the destination D1 row (with
   * lineage). The caller must copy git objects afterwards and roll back via
   * `rollbackFork` when the copy fails.
   */
  public async createForkRow(
    forkerEmail: string,
    sourceOwner: string,
    sourceName: string,
    dest: { owner?: string; name?: string; description?: string | null; isPrivate?: boolean },
  ): Promise<{ id: string; owner: string; name: string; fullName: string; source: RepositoryRow; isPrivate: boolean }> {
    const dao = await this.deps.repositoryDAO();
    const source = await dao.getByOwnerAndName(sourceOwner, sourceName);
    if (!source) throw new NotFoundError('Repository not found');
    const permission = await this.permission();
    const role = await permission.getRole(forkerEmail, source);
    if (!role) throw new NotFoundError('Repository not found');

    const destOwner = (dest.owner ?? '').trim() || (await this.resolveDefaultOwner(forkerEmail));
    const destName = (dest.name ?? '').trim() || source.name;
    const normalizedName = RepoFullName.normalizeRepo(destName);
    RepoService.validateNames(RepoFullName.normalizeOwner(destOwner), normalizedName);

    const sourceFullName = `${source.owner}/${source.name}`;
    const destFullName = `${destOwner}/${normalizedName}`;
    if (destFullName.toLowerCase() === sourceFullName.toLowerCase()) {
      throw new BadRequestError('Cannot fork a repository into itself');
    }

    // A private source must stay private: forks cannot leak it publicly.
    const sourcePrivate = source.is_private === 1;
    const isPrivate = sourcePrivate ? true : (dest.isPrivate ?? false);
    const description = dest.description === undefined ? (source.description ?? null) : dest.description;

    const { id } = await this.repoService().createRepo(forkerEmail, destOwner, normalizedName, description, isPrivate, {
      forkedFromRepoId: source.id,
      forkedFromFullName: sourceFullName,
    });
    const created = await dao.getById(id);
    const canonicalOwner = created?.owner ?? destOwner;
    return { id, owner: canonicalOwner, name: normalizedName, fullName: `${canonicalOwner}/${normalizedName}`, source, isPrivate };
  }

  // Best-effort rollback of a fork whose git copy failed (D1 row only).
  public async rollbackFork(id: string): Promise<void> {
    try {
      const dao = await this.deps.repositoryDAO();
      await dao.deleteById(id);
    } catch {
      // best-effort — D1 is reconciled on retry (destination already exists)
    }
  }

  public async listForks(sourceRepoId: string, limit = 100): Promise<RepositoryRow[]> {
    const dao = await this.deps.repositoryDAO();
    return dao.listForks(sourceRepoId, limit);
  }

  public async countForks(sourceRepoId: string): Promise<number> {
    const dao = await this.deps.repositoryDAO();
    return dao.countForks(sourceRepoId);
  }
}

export { ForkService };
export type { ForkServiceDeps, ForkServiceEnv };
