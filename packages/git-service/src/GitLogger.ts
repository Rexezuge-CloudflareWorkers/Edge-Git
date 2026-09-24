// Layer 2 logger contract for git-service.
//
// Why: git-service cannot depend on request-scoped DI (backend-runtime
// ServiceContext) yet every module hand-rolled
// `const logger = { warn: (...a) => console.warn(...) }`. That blocks unit
// tests from silencing logs and hides the sink. This Adapter centralizes the
// console sink behind an injectable interface; services accept an optional
// logger and default to the console implementation so existing call sites
// keep working (breaking: constructors now accept a third options object).

interface GitLogger {
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const consoleGitLogger: GitLogger = {
  warn: (...args: unknown[]): void => console.warn('[WARN] [GitService]', ...args),
  info: (...args: unknown[]): void => console.info('[INFO] [GitService]', ...args),
  error: (...args: unknown[]): void => console.error('[ERROR] [GitService]', ...args),
};

const mergeGitLogger: GitLogger = {
  warn: (...args: unknown[]): void => console.warn('[WARN] [MergeService]', ...args),
  info: (...args: unknown[]): void => console.info('[INFO] [MergeService]', ...args),
  error: (...args: unknown[]): void => console.error('[ERROR] [MergeService]', ...args),
};

const nullGitLogger: GitLogger = {
  warn: (..._args: unknown[]): void => {},
  info: (..._args: unknown[]): void => {},
  error: (..._args: unknown[]): void => {},
};

export { consoleGitLogger, mergeGitLogger, nullGitLogger };
export type { GitLogger };
