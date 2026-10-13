/**
 * The namespaced logger — the kit's (`@rexezuge/runtime`).
 *
 * `createLogger(namespace?, fullRepoName?, env?)` resolves `LOG_LEVEL` from the
 * injected env and returns the four methods every worker uses. Re-exported here
 * so `@edge-git/backend-runtime/logger` stays a valid import path for the
 * background and API workers, which all reach for it by name.
 */
export { createLogger, isLogLevel, resolveLogLevel } from '@rexezuge/runtime';
export type { LogLevel, Logger } from '@rexezuge/runtime';