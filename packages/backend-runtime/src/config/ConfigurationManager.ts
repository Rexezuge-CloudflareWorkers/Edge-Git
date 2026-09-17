import {
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
  DEFAULT_BACKGROUND_TASK_RUN_RETENTION_DAYS,
  DEFAULT_DEBUG_MODE,
  DEFAULT_GIT_CACHE_TTL_SECONDS,
  DEFAULT_MAX_ASSETS_PER_RELEASE,
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_MAX_CARDS_PER_COLUMN,
  DEFAULT_MAX_COLUMNS_PER_PROJECT,
  DEFAULT_MAX_DISCUSSIONS_PER_REPO,
  DEFAULT_MAX_FETCH_BODY_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FETCH_HAVES,
  DEFAULT_MAX_FETCH_WANTS,
  DEFAULT_MAX_FILES_PER_SNIPPET,
  DEFAULT_MAX_HOOKS_PER_REPO,
  DEFAULT_MAX_MERGE_DIFF_FILES,
  DEFAULT_MAX_PACK_BYTES,
  DEFAULT_MAX_PACK_OBJECTS,
  DEFAULT_MAX_PROJECTS_PER_REPO,
  DEFAULT_MAX_PUSH_COMMANDS,
  DEFAULT_MAX_RELEASES_PER_REPO,
  DEFAULT_MAX_REPOS_PER_USER,
  DEFAULT_MAX_RULES_PER_REPO,
  DEFAULT_MAX_SNIPPET_BYTES,
  DEFAULT_MAX_SNIPPETS_PER_USER,
  DEFAULT_MAX_TEAMS_PER_ORG,
  DEFAULT_MAX_TEAM_GRANTS,
  DEFAULT_MAX_TEAM_MEMBERS,
  DEFAULT_MAX_TOKENS_PER_USER,
  DEFAULT_MAX_TOKEN_EXPIRY_DAYS,
  DEFAULT_MAX_WIKI_BODY_BYTES,
  DEFAULT_MAX_WIKI_PAGES_PER_REPO,
  DEFAULT_SITE_URL,
  DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS,
  DEFAULT_WEBHOOK_MAX_ATTEMPTS,
  DEFAULT_WEBHOOK_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES,
  DEFAULT_WEBHOOK_TIMEOUT_MS,
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

  public static readonly webhooks = {
    getMaxPerRepo: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_HOOKS_PER_REPO', DEFAULT_MAX_HOOKS_PER_REPO),
    getDeliveryRetentionDays: (env: unknown): number =>
      EnvParser.positiveInt(env, 'WEBHOOK_DELIVERY_RETENTION_DAYS', DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS),
    getMaxAttempts: (env: unknown): number => EnvParser.positiveInt(env, 'WEBHOOK_MAX_ATTEMPTS', DEFAULT_WEBHOOK_MAX_ATTEMPTS),
    getTimeoutMs: (env: unknown): number => EnvParser.positiveInt(env, 'WEBHOOK_TIMEOUT_MS', DEFAULT_WEBHOOK_TIMEOUT_MS),
    getMaxConsecutiveFailures: (env: unknown): number =>
      EnvParser.positiveInt(env, 'WEBHOOK_MAX_CONSECUTIVE_FAILURES', DEFAULT_WEBHOOK_MAX_CONSECUTIVE_FAILURES),
    getMaxPayloadBytes: (env: unknown): number =>
      EnvParser.positiveInt(env, 'WEBHOOK_MAX_PAYLOAD_BYTES', DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES),
  };

  public static readonly releases = {
    getMaxPerRepo: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_RELEASES_PER_REPO', DEFAULT_MAX_RELEASES_PER_REPO),
    getMaxAssetsPerRelease: (env: unknown): number =>
      EnvParser.positiveInt(env, 'MAX_ASSETS_PER_RELEASE', DEFAULT_MAX_ASSETS_PER_RELEASE),
    getMaxAssetBytes: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_ASSET_BYTES', DEFAULT_MAX_ASSET_BYTES),
  };

  public static readonly collabSurfaces = {
    getMaxProjectsPerRepo: (env: unknown): number =>
      EnvParser.positiveInt(env, 'MAX_PROJECTS_PER_REPO', DEFAULT_MAX_PROJECTS_PER_REPO),
    getMaxColumnsPerProject: (env: unknown): number =>
      EnvParser.positiveInt(env, 'MAX_COLUMNS_PER_PROJECT', DEFAULT_MAX_COLUMNS_PER_PROJECT),
    getMaxCardsPerColumn: (env: unknown): number =>
      EnvParser.positiveInt(env, 'MAX_CARDS_PER_COLUMN', DEFAULT_MAX_CARDS_PER_COLUMN),
    getMaxDiscussionsPerRepo: (env: unknown): number =>
      EnvParser.positiveInt(env, 'MAX_DISCUSSIONS_PER_REPO', DEFAULT_MAX_DISCUSSIONS_PER_REPO),
    getMaxWikiPagesPerRepo: (env: unknown): number =>
      EnvParser.positiveInt(env, 'MAX_WIKI_PAGES_PER_REPO', DEFAULT_MAX_WIKI_PAGES_PER_REPO),
    getMaxWikiBodyBytes: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_WIKI_BODY_BYTES', DEFAULT_MAX_WIKI_BODY_BYTES),
    getMaxSnippetsPerUser: (env: unknown): number =>
      EnvParser.positiveInt(env, 'MAX_SNIPPETS_PER_USER', DEFAULT_MAX_SNIPPETS_PER_USER),
    getMaxFilesPerSnippet: (env: unknown): number =>
      EnvParser.positiveInt(env, 'MAX_FILES_PER_SNIPPET', DEFAULT_MAX_FILES_PER_SNIPPET),
    getMaxSnippetBytes: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_SNIPPET_BYTES', DEFAULT_MAX_SNIPPET_BYTES),
  };

  public static readonly teams = {
    getMaxPerOrg: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_TEAMS_PER_ORG', DEFAULT_MAX_TEAMS_PER_ORG),
    getMaxMembers: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_TEAM_MEMBERS', DEFAULT_MAX_TEAM_MEMBERS),
    getMaxGrants: (env: unknown): number => EnvParser.positiveInt(env, 'MAX_TEAM_GRANTS', DEFAULT_MAX_TEAM_GRANTS),
  };

  public static getDebugMode(env: unknown): boolean {
    return EnvParser.boolean(env, 'DEBUG_MODE', DEFAULT_DEBUG_MODE);
  }
}

export { ConfigurationManager };
