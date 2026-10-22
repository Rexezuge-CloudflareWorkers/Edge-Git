/**
 * The namespaced logger — the kit's (`@rexezuge/runtime`), over a redacting sink.
 *
 * `createLogger(namespace?, fullRepoName?, env?)` resolves `LOG_LEVEL` from the
 * injected env and returns the four methods every worker uses. Re-exported here
 * so `@edge-git/backend-runtime/logger` stays a valid import path for the
 * background and API workers, which all reach for it by name.
 *
 * Two things are added on top of the kit's, and both are the kit's own
 * seams rather than a reimplementation of it:
 *
 * - **The sink.** The kit owns the level decision, the namespace prefix and
 *   the argument list; the sink owns what happens to the bytes. Redaction
 *   belongs here because a check at each call site is a hundred chances to
 *   forget one, and this repo's surfaces carry webhook signing secrets,
 *   personal-access tokens and bearer headers.
 * - **The level.** The kit reads the level *per emit*, so a logger built at
 *   module scope — which is every logger in this repo — picks up whatever
 *   `setLogLevel` installed without being rebuilt. Without it, `LOG_LEVEL` was
 *   inert: the only source a module-scope logger could read was
 *   `process.env`, which workerd does not have.
 */
import { consoleSink, createLogger as kitCreateLogger } from '@rexezuge/runtime';
import type { LogLevel, LogSink, Logger } from '@rexezuge/runtime';
import { ErrorSanitizationUtil } from '@rexezuge/shared';

/**
 * One payload, sanitized.
 *
 * A string is redacted in place; an error is replaced by its redacted
 * `name: message` and stack, because the stack repeats the message and can
 * name the very secret the message carries.
 */
function sanitizeForLog(value: unknown): unknown {
  if (typeof value === 'string') return ErrorSanitizationUtil.sanitizeMessage(value);
  if (value instanceof Error) return ErrorSanitizationUtil.sanitizeErrorForLogging(value);
  return value;
}

/**
 * Where every accepted emit goes.
 */
const redactingSink: LogSink = (level: LogLevel, message: string, args: readonly unknown[]): void => {
  consoleSink(level, message, args.map(sanitizeForLog));
};

/**
 * @param sink Where each accepted emit goes. Defaults to the redacting sink.
 */
function createLogger(namespace?: string, fullRepoName?: string, env?: unknown, sink: LogSink = redactingSink): Logger {
  return kitCreateLogger(namespace, fullRepoName, env, sink);
}

export { consoleSink, isLogLevel, resetLogLevelForTests, resolveLogLevel, setLogLevel, type LogLevel, type Logger, type LogSink } from '@rexezuge/runtime';
export { createLogger, redactingSink };
