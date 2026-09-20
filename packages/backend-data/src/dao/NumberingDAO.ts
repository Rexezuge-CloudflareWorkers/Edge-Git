import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';

type NumberedEntity = 'issue' | 'pull' | 'discussion' | 'project';

// Entity → table whitelist for the seed subquery. Table names are never
// interpolated from caller input — unknown entities throw before any SQL.
const NUMBERED_ENTITY_TABLES: Record<NumberedEntity, string> = {
  issue: 'issues',
  pull: 'pull_requests',
  discussion: 'discussions',
  project: 'projects',
};

const NUMBERED_ENTITIES: readonly NumberedEntity[] = ['issue', 'pull', 'discussion', 'project'];

function isNumberedEntity(value: string): value is NumberedEntity {
  return (NUMBERED_ENTITIES as readonly string[]).includes(value);
}

// Atomic per-repo numbering allocator over `repo_number_counters`
// (migration 0020). A single UPSERT ... RETURNING hands out distinct numbers
// even under concurrent POSTs; the seed subquery starts new counters above
// the current MAX(number) so pre-existing rows never collide.
//
// Throws on unexpected shapes (missing table on legacy DBs, fakes without
// the table): callers fall back to the legacy MAX+1 loop, with the 0019
// UNIQUE indexes + 3-attempt retry as the backstop. The allocator is an
// optimization, never a new failure mode.
class NumberingDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async allocateNumber(repositoryId: string, entity: NumberedEntity): Promise<number> {
    if (!isNumberedEntity(entity)) throw new Error(`Unknown numbered entity: ${entity as string}`);
    const table = NUMBERED_ENTITY_TABLES[entity];
    const row = await this.database
      .prepare(
        `INSERT INTO repo_number_counters (repository_id, entity, next_number) VALUES (?, ?, (SELECT COALESCE(MAX(number), 0) + 2 FROM ${table} WHERE repository_id = ?)) ON CONFLICT (repository_id, entity) DO UPDATE SET next_number = next_number + 1 RETURNING next_number - 1 AS n`,
      )
      .bind(repositoryId, entity, repositoryId)
      .first<{ n: number }>();
    if (!row || typeof row.n !== 'number' || !Number.isSafeInteger(row.n) || row.n < 1) {
      throw new Error('no such table: repo_number_counters');
    }
    return row.n;
  }
}

export { NumberingDAO };
export type { NumberedEntity };
