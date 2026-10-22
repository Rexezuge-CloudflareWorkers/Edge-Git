import { BaseDAO as KitBaseDAO, executeWithRetry } from '@rexezuge/d1';
import type { D1PreparedStatement, D1Queryable, D1Result } from '@rexezuge/d1';
import { CursorCodec } from '@rexezuge/shared';
import type { SubrequestMeter } from '@rexezuge/shared';
import { assertSqlIdentifier } from '@rexezuge/d1';

/**
 * Edge-Git's DAO base.
 *
 * The retry policy, the `success: false` → `DatabaseError` normalization and
 * the sql-first `run`/`first`/`all`/`count`/`batch` helpers are the kit's, so a
 * D1 constraint failure is one typed error everywhere and every read site
 * states its SQL instead of wrapping it in a closure it mostly did not need.
 *
 * What stays here is what is *not* a D1 policy: the by-primary-key lookup and
 * the opaque-cursor helpers, both of which every DAO in this repo reaches for.
 * Cursors live in `@rexezuge/shared`'s `CursorCodec` rather than the local
 * `CursorUtil` — same encoding, one copy.
 *
 * The meter is a constructor dependency, not a module singleton: the kit's
 * `BaseDAO` charges every statement it runs against it, and the composition
 * root hands each DAO the counter for the invocation it is serving. A DAO
 * constructed without one runs unmetered, which under-reports silently — it
 * spends a subrequest the ceiling never saw.
 */
abstract class BaseDAO extends KitBaseDAO {
  protected constructor(database: D1Queryable, meter?: SubrequestMeter) {
    super(database, meter);
  }

  /**
   * Escape hatch for the operations the sql-first helpers do not cover — a
   * `Database.batch()` the kit does not own, or a statement whose result shape
   * the caller must inspect itself. Prefer `run`/`first`/`all`.
   */
  protected withRetry(operation: () => Promise<D1Result>, context: string): Promise<D1Result> {
    return executeWithRetry(operation, context);
  }

  /**
   * One prepared statement with its bindings applied. Bindings are always
   * parameters — never interpolation.
   */
  protected prepare(sql: string, bindings: unknown[] = []): D1PreparedStatement {
    return bindings.length > 0 ? this.database.prepare(sql).bind(...bindings) : this.database.prepare(sql);
  }

  // Instance variants of the static helpers below, bound to this DAO's
  // database so subclasses stop threading `db` through every call.
  protected findRowById<T>(table: string, idColumn: string, idValue: string, columns = '*'): Promise<T | null> {
    return BaseDAO.findById<T>(this.database, table, idColumn, idValue, columns);
  }

  protected deleteRowsOlderThan(
    table: string,
    timeColumn: string,
    cutoff: number | string,
    limit: number,
    idColumn: string,
  ): Promise<number> {
    return BaseDAO.deleteOlderThan(this.database, table, timeColumn, cutoff, limit, idColumn);
  }

  // Shared opaque-cursor codec. Per-DAO `encodeCursor/parseCursor` wrappers
  // should delegate here and only add payload validation.
  protected encodeCursor(value: unknown): string {
    return CursorCodec.encode(value);
  }

  protected decodeCursor<T>(cursor: string | undefined): T | undefined {
    return CursorCodec.decode<T>(cursor);
  }

  /**
   * Strict decode for the paginated query DAOs.
   *
   * "OrThrow" is about a cursor the client *sent*: a malformed one is a bug or
   * a tamper attempt and must not silently read as "start from the beginning".
   * An absent cursor is not an error — it is the first page — so it still
   * decodes to `undefined` and the caller keeps its `decoded === undefined`
   * branch. The kit's `decodeOrThrow` takes a `string` and throws on `atob('')`,
   * so the absent case is split off here rather than at each of the four DAOs.
   */
  protected decodeCursorOrThrow<T>(cursor: string | undefined): T | undefined {
    return cursor ? CursorCodec.decodeOrThrow<T>(cursor) : undefined;
  }

  // Generic row lookup by primary key. Table/column identifiers are allow-listed
  // to keep dynamic SQL safe; values always go through bindings.
  protected static async findById<T>(
    db: D1Queryable,
    table: string,
    idColumn: string,
    idValue: string,
    columns = '*',
  ): Promise<T | null> {
    assertSqlIdentifier(table, 'table');
    assertSqlIdentifier(idColumn, 'idColumn');
    let selectColumns = '*';
    if (columns !== '*') {
      const validated: string[] = columns.split(',').map((column: string): string => {
        const trimmed: string = column.trim();
        assertSqlIdentifier(trimmed, 'column');
        return trimmed;
      });
      selectColumns = validated.join(', ');
    }
    const row: T | null = await db
      .prepare(`SELECT ${selectColumns} FROM ${table} WHERE ${idColumn} = ? LIMIT 1`)
      .bind(idValue)
      .first<T>();
    return row ?? null;
  }
}

/**
 * Base for a DAO whose columns hold AES-GCM envelopes. The master key is a
 * constructor argument, never an env lookup, so a DAO cannot read a key it was
 * not wired with.
 */
abstract class EncryptedDAO extends BaseDAO {
  constructor(
    database: D1Queryable,
    protected readonly masterKey: string,
    meter?: SubrequestMeter,
  ) {
    super(database, meter);
  }
}

export { BaseDAO, EncryptedDAO };

export {type D1Queryable, type D1Result} from '@rexezuge/d1';