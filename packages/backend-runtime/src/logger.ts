type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

function isLogLevel(level: string): level is LogLevel {
  return level === 'debug' || level === 'info' || level === 'warn' || level === 'error';
}

function resolveLogLevel(): LogLevel {
  const fromEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LOG_LEVEL;
  const level = fromEnv ?? 'info';
  return isLogLevel(level) ? level : 'info';
}

export function createLogger(namespace?: string, fullRepoName?: string) {
  const currentLevel = resolveLogLevel();
  const minLevel = LOG_LEVELS[currentLevel];

  const argsStr = [fullRepoName, namespace]
    .filter(Boolean)
    .map((s) => `[${s}]`)
    .join(' ');

  return {
    debug: (...args: unknown[]) => {
      if (LOG_LEVELS.debug >= minLevel) {
        console.debug(`[DEBUG] ${argsStr}`, ...args);
      }
    },
    info: (...args: unknown[]) => {
      if (LOG_LEVELS.info >= minLevel) {
        console.info(`[INFO] ${argsStr}`, ...args);
      }
    },
    warn: (...args: unknown[]) => {
      if (LOG_LEVELS.warn >= minLevel) {
        console.warn(`[WARN] ${argsStr}`, ...args);
      }
    },
    error: (...args: unknown[]) => {
      if (LOG_LEVELS.error >= minLevel) {
        console.error(`[ERROR] ${argsStr}`, ...args);
      }
    },
  };
}

export type { LogLevel };
