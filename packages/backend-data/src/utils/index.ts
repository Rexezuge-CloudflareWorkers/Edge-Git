/**
 * `@edge-git/backend-data/utils` — the D1 surface.
 *
 * The retry engine (`executeWithRetry`), the error classifier and the structural
 * D1 types are the kit's (`@rexezuge/d1`), so a constraint failure is one typed
 * `DatabaseError` everywhere and no repo can drift its own schedule. What is
 * left here is Edge-Git's D1 *domain*: the retention/batching arithmetic and
 * the pure SQL builders, neither of which the kit has an opinion about.
 */

export { executeWithRetry, sleep, backoffMs, D1_RETRY_DEFAULTS, isD1ErrorRetryable, isMissingSchemaError } from '@rexezuge/d1';
export type { D1PreparedStatement, D1Queryable, D1Result, D1RetryOptions } from '@rexezuge/d1';

export { computeDateCutoffIso, computeUnixCutoffSeconds, pruneInBatches } from '../dao/collab';
export * from '../dao/CollaborationQueries';