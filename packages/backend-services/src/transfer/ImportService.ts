import { ImportDAO } from '@edge-git/backend-data/dao';
import type { ImportStatus, RepoImportRow } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError, NotFoundError } from '@edge-git/backend-errors';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import type { RepoImportMetadata } from '@edge-git/shared';
import { TimestampUtil, UUIDUtil } from '@edge-git/shared/utils';
import { normalizePublicGitUrl } from '@edge-git/git-protocol';

interface ImportServiceEnv {
  DB: D1Queryable;
  MAX_IMPORT_BYTES?: string;
  MAX_IMPORT_REFS?: string;
  IMPORT_CLAIM_STALE_SECONDS?: string;
}

interface ImportServiceDeps {
  importDAO?: () => Promise<ImportDAO>;
}

function toMetadata(row: RepoImportRow): RepoImportMetadata {
  // Refs live only in `repo_import_refs` (0024 dropped the JSON column):
  // static metadata carries null; `withJunctionRefs` fills from the junction.
  return {
    id: row.id,
    repositoryId: row.repository_id,
    sourceUrl: row.source_url,
    status: row.status,
    error: row.error,
    refs: null,
    importedRefs: row.imported_refs,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class ImportService {
  private readonly deps: Required<ImportServiceDeps>;

  constructor(
    private readonly env: ImportServiceEnv,
    deps: ImportServiceDeps = {},
  ) {
    this.deps = {
      importDAO: () => Promise.resolve(new ImportDAO(env.DB)),
      ...deps,
    };
  }

  public static toMetadata(row: RepoImportRow): RepoImportMetadata {
    return toMetadata(row);
  }

  private async withJunctionRefs(meta: RepoImportMetadata): Promise<RepoImportMetadata> {
    // Junction-first read with JSON fallback. The `typeof` guard keeps
    // minimal test fakes (objects without the new method) on the JSON path.
    try {
      const dao = await this.deps.importDAO();
      if (typeof dao.listRefs !== 'function') return meta;
      const junction = await dao.listRefs(meta.id);
      if (junction.length > 0) return { ...meta, refs: junction.map((r) => ({ ref: r.ref, oid: r.oid ?? '' })) };
    } catch {
      // JSON fallback in `meta`.
    }
    return meta;
  }

  public async createJob(repositoryId: string, sourceUrl: string, createdBy: string): Promise<RepoImportMetadata> {
    const normalized = normalizePublicGitUrl(sourceUrl);
    const dao = await this.deps.importDAO();
    if (await dao.hasActiveForRepo(repositoryId).catch(() => false)) {
      throw new BadRequestError('An import is already in progress for this repository');
    }
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const id = UUIDUtil.getRandomUUID();
    await dao.create({ id, repositoryId, sourceUrl: normalized, createdBy: createdBy.toLowerCase(), now });
    // Post-create single-flight: two concurrent POSTs can both pass the
    // pre-check. If we lost the race, cancel our own job and surface 400.
    try {
      const active = await dao.countActiveForRepo(repositoryId).catch(() => 1);
      if (active > 1) {
        await dao.markCancelled(id, TimestampUtil.getCurrentUnixTimestampInSeconds()).catch(() => undefined);
        throw new BadRequestError('An import is already in progress for this repository');
      }
    } catch (error) {
      if (error instanceof BadRequestError) throw error;
      // Count lookup failure must not fail the job itself.
    }
    const row = await dao.getById(id);
    if (!row) throw new NotFoundError('Import not found');
    return this.withJunctionRefs(toMetadata(row));
  }

  public async latestForRepo(repositoryId: string): Promise<RepoImportMetadata | null> {
    const dao = await this.deps.importDAO();
    const row = await dao.latestByRepo(repositoryId).catch(() => null);
    if (!row) return null;
    return this.withJunctionRefs(toMetadata(row));
  }

  public async cancelJob(jobId: string, repositoryId?: string): Promise<RepoImportMetadata> {
    const dao = await this.deps.importDAO();
    const row = await dao.getById(jobId);
    if (!row) throw new NotFoundError('Import not found');
    // Scope the cancel to the caller's repo: without this, an admin of repo A
    // could cancel repo B's job by guessing its UUID.
    if (repositoryId !== undefined && row.repository_id !== repositoryId) throw new NotFoundError('Import not found');
    if (row.status !== 'pending' && row.status !== 'running') {
      throw new BadRequestError(`Import is already ${row.status}`);
    }
    await dao.markCancelled(jobId, TimestampUtil.getCurrentUnixTimestampInSeconds());
    const updated = await dao.getById(jobId);
    if (!updated) throw new NotFoundError('Import not found');
    return this.withJunctionRefs(toMetadata(updated));
  }

  public transferLimits(): { maxRefs: number; maxPackBytes: number; timeoutMs: number; staleSeconds: number } {
    return {
      maxRefs: ConfigurationManager.transfer.getMaxImportRefs(this.env),
      maxPackBytes: ConfigurationManager.transfer.getMaxImportBytes(this.env),
      timeoutMs: 20_000,
      staleSeconds: ConfigurationManager.transfer.getImportClaimStaleSeconds(this.env),
    };
  }

  public importStatus(value: string): ImportStatus {
    if ((['pending', 'running', 'done', 'failed', 'cancelled'] as readonly string[]).includes(value)) return value as ImportStatus;
    throw new BadRequestError('Invalid import status');
  }
}

export { ImportService };
export type { ImportServiceDeps, ImportServiceEnv };
