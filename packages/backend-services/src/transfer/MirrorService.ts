import { MirrorDAO } from '@edge-git/backend-data/dao';
import type { RepoMirrorRow } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError, NotFoundError } from '@edge-git/backend-errors';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import type { RepoMirrorMetadata } from '@edge-git/shared';
import { TimestampUtil } from '@edge-git/shared/utils';
import { normalizePublicGitUrl } from '@edge-git/git-protocol';

interface MirrorServiceEnv {
  DB: D1Queryable;
  MAX_MIRROR_FAILURES?: string;
}

interface MirrorServiceDeps {
  mirrorDAO?: () => Promise<MirrorDAO>;
}

const MIRROR_INTERVALS = [60, 360, 720, 1440, 10_080] as const;

function toMetadata(row: RepoMirrorRow): RepoMirrorMetadata {
  return {
    repositoryId: row.repository_id,
    sourceUrl: row.source_url,
    intervalMinutes: row.interval_minutes,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class MirrorService {
  private readonly deps: Required<MirrorServiceDeps>;

  constructor(
    private readonly env: MirrorServiceEnv,
    deps: MirrorServiceDeps = {},
  ) {
    this.deps = {
      mirrorDAO: () => Promise.resolve(new MirrorDAO(env.DB)),
      ...deps,
    };
  }

  public static allowedIntervals(): readonly number[] {
    return MIRROR_INTERVALS;
  }

  public async configure(repositoryId: string, sourceUrl: string, intervalMinutes: number, createdBy: string): Promise<RepoMirrorMetadata> {
    if (!MIRROR_INTERVALS.includes(intervalMinutes as (typeof MIRROR_INTERVALS)[number])) {
      throw new BadRequestError(`intervalMinutes must be one of ${MIRROR_INTERVALS.join(', ')}`);
    }
    const normalized = normalizePublicGitUrl(sourceUrl);
    const dao = await this.deps.mirrorDAO();
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    await dao.upsert({ repositoryId, sourceUrl: normalized, intervalMinutes, createdBy: createdBy.toLowerCase(), now });
    const row = await dao.getByRepo(repositoryId);
    if (!row) throw new NotFoundError('Mirror not found');
    return toMetadata(row);
  }

  public async getForRepo(repositoryId: string): Promise<RepoMirrorMetadata | null> {
    const dao = await this.deps.mirrorDAO();
    const row = await dao.getByRepo(repositoryId).catch(() => null);
    return row ? toMetadata(row) : null;
  }

  public async remove(repositoryId: string): Promise<void> {
    const dao = await this.deps.mirrorDAO();
    await dao.deleteByRepo(repositoryId);
  }

  public async setEnabled(repositoryId: string, enabled: boolean): Promise<RepoMirrorMetadata> {
    const dao = await this.deps.mirrorDAO();
    const existing = await dao.getByRepo(repositoryId);
    if (!existing) throw new NotFoundError('Mirror not found');
    await dao.setEnabled(repositoryId, enabled, TimestampUtil.getCurrentUnixTimestampInSeconds());
    const row = await dao.getByRepo(repositoryId);
    if (!row) throw new NotFoundError('Mirror not found');
    return toMetadata(row);
  }

  public maxFailures(): number {
    return ConfigurationManager.transfer.getMaxMirrorFailures(this.env);
  }
}

export { MirrorService };
export type { MirrorServiceDeps, MirrorServiceEnv };
