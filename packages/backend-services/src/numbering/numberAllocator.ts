import type { NumberedEntity, NumberingDAO } from '@edge-git/backend-data/dao';

/**
 * Allocate a per-repo number via the atomic `repo_number_counters` table,
 * falling back to the caller's legacy MAX+1 reader when the allocator is
 * unavailable (legacy DBs without migration 0020, unit fakes).
 *
 * The fallback is always safe: the 0019 UNIQUE(repository_id, number)
 * indexes plus the services' 3-attempt retry loops stay as the correctness
 * backstop, so the allocator is an optimization — never a new failure mode.
 * A genuine D1 outage still surfaces (the fallback reader fails too).
 */
async function allocateNumberWithFallback(
  numberingDAO: () => Promise<NumberingDAO>,
  legacyNextNumber: () => Promise<number>,
  repositoryId: string,
  entity: NumberedEntity,
): Promise<number> {
  try {
    const dao = await numberingDAO();
    return await dao.allocateNumber(repositoryId, entity);
  } catch {
    return legacyNextNumber();
  }
}

export { allocateNumberWithFallback };
