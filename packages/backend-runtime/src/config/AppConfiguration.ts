import { EnvParser } from './EnvParser';
import {
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
  DEFAULT_BACKGROUND_TASK_RUN_RETENTION_DAYS,
  DEFAULT_DEBUG_MODE,
  DEFAULT_GIT_CACHE_TTL_SECONDS,
  DEFAULT_MAX_FETCH_BODY_BYTES,
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

/**
 * Injectable instance view over Edge-Git environment configuration.
 *
 * `ConfigurationManager` statics remain as a thin facade delegating here for
 * backward compatibility. New code should accept `AppConfiguration` via
 * constructor injection so env parsing is stubbable.
 */
class AppConfiguration {
  constructor(private readonly env: unknown) {}

  public static fromEnv(env: unknown): AppConfiguration {
    return new AppConfiguration(env);
  }

  public getDebugMode(): boolean {
    return EnvParser.boolean(this.env, 'DEBUG_MODE', DEFAULT_DEBUG_MODE);
  }

  public getSiteUrl(): string {
    let url = EnvParser.string(this.env, 'SITE_URL', DEFAULT_SITE_URL);
    while (url.endsWith('/')) url = url.slice(0, -1);
    return url;
  }

  public isServeSpaFromWorker(): boolean {
    return EnvParser.boolean(this.env, 'SERVE_SPA_FROM_WORKER', DEFAULT_SERVE_SPA_FROM_WORKER);
  }

  public getMaxReposPerUser(): number {
    return EnvParser.positiveInt(this.env, 'MAX_REPOS_PER_USER', DEFAULT_MAX_REPOS_PER_USER);
  }

  public getMaxTokensPerUser(): number {
    return EnvParser.positiveInt(this.env, 'MAX_TOKENS_PER_USER', DEFAULT_MAX_TOKENS_PER_USER);
  }

  public getMaxTokenExpiryDays(): number {
    return EnvParser.positiveInt(this.env, 'MAX_TOKEN_EXPIRY_DAYS', DEFAULT_MAX_TOKEN_EXPIRY_DAYS);
  }

  public getMaxPackObjects(): number {
    return EnvParser.positiveInt(this.env, 'MAX_PACK_OBJECTS', DEFAULT_MAX_PACK_OBJECTS);
  }

  public getGitCacheTtlSeconds(): number {
    return EnvParser.positiveInt(this.env, 'GIT_CACHE_TTL_SECONDS', DEFAULT_GIT_CACHE_TTL_SECONDS);
  }

  public getMaxFetchWants(): number {
    return EnvParser.positiveInt(this.env, 'MAX_FETCH_WANTS', DEFAULT_MAX_FETCH_WANTS);
  }

  public getMaxFetchHaves(): number {
    return EnvParser.positiveInt(this.env, 'MAX_FETCH_HAVES', DEFAULT_MAX_FETCH_HAVES);
  }

  public getMaxPushCommands(): number {
    return EnvParser.positiveInt(this.env, 'MAX_PUSH_COMMANDS', DEFAULT_MAX_PUSH_COMMANDS);
  }

  public getMaxPackBytes(): number {
    return EnvParser.positiveInt(this.env, 'MAX_PACK_BYTES', DEFAULT_MAX_PACK_BYTES);
  }

  public getMaxFetchBodyBytes(): number {
    return EnvParser.positiveInt(this.env, 'MAX_FETCH_BODY_BYTES', DEFAULT_MAX_FETCH_BODY_BYTES);
  }

  public getMaxMergeDiffFiles(): number {
    return EnvParser.positiveInt(this.env, 'MAX_MERGE_DIFF_FILES', DEFAULT_MAX_MERGE_DIFF_FILES);
  }

  public getMaxRulesPerRepo(): number {
    return EnvParser.positiveInt(this.env, 'MAX_RULES_PER_REPO', DEFAULT_MAX_RULES_PER_REPO);
  }

  public getTaskRunRetentionDays(): number {
    return EnvParser.positiveInt(this.env, 'BACKGROUND_TASK_RUN_RETENTION_DAYS', DEFAULT_BACKGROUND_TASK_RUN_RETENTION_DAYS);
  }

  public getAuditLogRetentionDays(): number {
    return EnvParser.positiveInt(this.env, 'AUDIT_LOG_RETENTION_DAYS', DEFAULT_AUDIT_LOG_RETENTION_DAYS);
  }

  public isDemoMode(): boolean {
    return EnvParser.boolean(this.env, 'DEMO_MODE', 'false');
  }
}

export { AppConfiguration };
