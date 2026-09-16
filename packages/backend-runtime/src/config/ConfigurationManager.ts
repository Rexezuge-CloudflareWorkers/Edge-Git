import {
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
  DEFAULT_BACKGROUND_TASK_RUN_RETENTION_DAYS,
  DEFAULT_DEBUG_MODE,
  DEFAULT_GIT_CACHE_TTL_SECONDS,
  DEFAULT_MAX_FETCH_BODY_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FETCH_HAVES,
  DEFAULT_MAX_FETCH_WANTS,
  DEFAULT_MAX_MERGE_DIFF_FILES,
  DEFAULT_MAX_PACK_BYTES,
  DEFAULT_MAX_PACK_OBJECTS,
  DEFAULT_MAX_PUSH_COMMANDS,
  DEFAULT_MAX_REPOS_PER_USER,
  DEFAULT_MAX_RULES_PER_REPO,
  DEFAULT_MAX_TOKENS_PER_USER,
  DEFAULT_MAX_TOKEN_EXPIRY_DAYS,
  DEFAULT_SERVE_SPA_FROM_WORKER,
  DEFAULT_SITE_URL,
} from './ConfigurationDefaults';
import { EnvParser } from './EnvParser';

class ConfigurationManager {
  public static readonly auth = {
    isDemoMode: (env: unknown): boolean => EnvParser.boolean(env, 'DEMO_MODE', 'false'),
  };

  public static readonly token = {
    getMaxPerUser: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_TOKENS_PER_USER', DEFAULT_MAX_TOKENS_PER_USER),
    getMaxExpiryDays: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_TOKEN_EXPIRY_DAYS', DEFAULT_MAX_TOKEN_EXPIRY_DAYS),
  };

  public static readonly repo = {
    getMaxPerUser: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_REPOS_PER_USER', DEFAULT_MAX_REPOS_PER_USER),
    getMaxPackObjects: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_PACK_OBJECTS', DEFAULT_MAX_PACK_OBJECTS),
    getCacheTtlSeconds: (env: unknown): number => EnvParser.positiveInt(env, 'GIT_CACHE_TTL_SECONDS', DEFAULT_GIT_CACHE_TTL_SECONDS),
    getMaxFetchWants: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_FETCH_WANTS', DEFAULT_MAX_FETCH_WANTS),
    getMaxFetchHaves: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_FETCH_HAVES', DEFAULT_MAX_FETCH_HAVES),
    getMaxPushCommands: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_PUSH_COMMANDS', DEFAULT_MAX_PUSH_COMMANDS),
    getMaxPackBytes: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_PACK_BYTES', DEFAULT_MAX_PACK_BYTES),
    getMaxFetchBodyBytes: (env: unknown): number =>
      EnvParser.positiveInt(env, 'MAX_FETCH_BODY_BYTES', DEFAULT_MAX_FETCH_BODY_BYTES),
    getMaxMergeDiffFiles: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_MERGE_DIFF_FILES', DEFAULT_MAX_MERGE_DIFF_FILES),
    getMaxFileBytes: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_FILE_BYTES', DEFAULT_MAX_FILE_BYTES),
    getMaxRulesPerRepo: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_RULES_PER_REPO', DEFAULT_MAX_RULES_PER_REPO),
  };

  public static readonly spa = {
    isServeFromWorker: (env: unknown): boolean => EnvParser.boolean(env, 'SERVE_SPA_FROM_WORKER', DEFAULT_SERVE_SPA_FROM_WORKER),
  };

  public static readonly site = {
    getSiteUrl: (env: unknown): string => {
      let url = EnvParser.string(env, 'SITE_URL', DEFAULT_SITE_URL);
      while (url.endsWith('/')) url = url.slice(0, -1);
      return url;
    },
  };

  public static readonly processing = {
    getTaskRunRetentionDays: (env: unknown): number =>
      EnvParser.positiveInt(env, 'BACKGROUND_TASK_RUN_RETENTION_DAYS', DEFAULT_BACKGROUND_TASK_RUN_RETENTION_DAYS),
    getAuditLogRetentionDays: (env: unknown): number => EnvParser.positiveInt(env, 'AUDIT_LOG_RETENTION_DAYS', DEFAULT_AUDIT_LOG_RETENTION_DAYS),
  };

  public static getDebugMode(env: unknown): boolean {
    return EnvParser.boolean(env, 'DEBUG_MODE', DEFAULT_DEBUG_MODE);
  }
}

export { ConfigurationManager };
