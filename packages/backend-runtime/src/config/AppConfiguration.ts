import { EnvParser } from './EnvParser';
import {
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
  DEFAULT_BACKGROUND_TASK_RUN_RETENTION_DAYS,
  DEFAULT_CHECK_CUSTOMJS_ENABLED,
  DEFAULT_CHECK_CUSTOMJS_MAX_CPU_MS,
  DEFAULT_CHECK_CUSTOMJS_MAX_FETCHES,
  DEFAULT_CHECK_CUSTOMJS_MAX_SCRIPT_BYTES,
  DEFAULT_CHECK_CUSTOMJS_MEMORY_MB,
  DEFAULT_CHECK_RETENTION_DAYS,
  DEFAULT_CHECK_TIMEOUT_SECONDS,
  DEFAULT_DEBUG_MODE,
  DEFAULT_GIT_CACHE_TTL_SECONDS,
  DEFAULT_IMPORT_CLAIM_STALE_SECONDS,
  DEFAULT_MAX_DEPLOY_KEYS_PER_REPO,
  DEFAULT_MAX_EXPORT_BYTES,
  DEFAULT_MAX_ASSETS_PER_RELEASE,
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_MAX_CARDS_PER_COLUMN,
  DEFAULT_MAX_CHECKS_PER_SHA,
  DEFAULT_MAX_COLUMNS_PER_PROJECT,
  DEFAULT_MAX_DISCUSSIONS_PER_REPO,
  DEFAULT_MAX_FETCH_BODY_BYTES,
  DEFAULT_MAX_FETCH_HAVES,
  DEFAULT_MAX_FETCH_WANTS,
  DEFAULT_MAX_FILES_PER_SNIPPET,
  DEFAULT_MAX_HOOKS_PER_REPO,
  DEFAULT_MAX_IMPORT_BYTES,
  DEFAULT_MAX_IMPORT_REFS,
  DEFAULT_MAX_MERGE_DIFF_FILES,
  DEFAULT_MAX_MIRROR_FAILURES,
  DEFAULT_MAX_PACK_BYTES,
  DEFAULT_MAX_PACK_OBJECTS,
  DEFAULT_MAX_PROJECTS_PER_REPO,
  DEFAULT_MAX_PUSH_COMMANDS,
  DEFAULT_MAX_RELEASES_PER_REPO,
  DEFAULT_MAX_REPOS_PER_USER,
  DEFAULT_MAX_RULES_PER_REPO,
  DEFAULT_MAX_SNIPPET_BYTES,
  DEFAULT_MAX_SNIPPETS_PER_USER,
  DEFAULT_MAX_TEAM_GRANTS,
  DEFAULT_MAX_TEAM_MEMBERS,
  DEFAULT_MAX_TEAMS_PER_ORG,
  DEFAULT_MAX_TOKENS_PER_USER,
  DEFAULT_MAX_TOKEN_EXPIRY_DAYS,
  DEFAULT_MAX_TOKEN_REPO_GRANTS,
  DEFAULT_MAX_WIKI_BODY_BYTES,
  DEFAULT_MAX_WIKI_PAGES_PER_REPO,
  DEFAULT_REALTIME_ENABLED,
  DEFAULT_REALTIME_MAX_CONN_PER_INBOX_SHARD,
  DEFAULT_REALTIME_MAX_CONN_PER_REPO_SHARD,
  DEFAULT_REALTIME_TICKET_TTL_SECONDS,
  DEFAULT_SITE_URL,
  DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS,
  DEFAULT_WEBHOOK_MAX_ATTEMPTS,
  DEFAULT_WEBHOOK_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES,
  DEFAULT_WEBHOOK_TIMEOUT_MS,
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

  public getMaxHooksPerRepo(): number {
    return EnvParser.positiveInt(this.env, 'MAX_HOOKS_PER_REPO', DEFAULT_MAX_HOOKS_PER_REPO);
  }

  public getWebhookDeliveryRetentionDays(): number {
    return EnvParser.positiveInt(this.env, 'WEBHOOK_DELIVERY_RETENTION_DAYS', DEFAULT_WEBHOOK_DELIVERY_RETENTION_DAYS);
  }

  public getWebhookMaxAttempts(): number {
    return EnvParser.positiveInt(this.env, 'WEBHOOK_MAX_ATTEMPTS', DEFAULT_WEBHOOK_MAX_ATTEMPTS);
  }

  public getWebhookTimeoutMs(): number {
    return EnvParser.positiveInt(this.env, 'WEBHOOK_TIMEOUT_MS', DEFAULT_WEBHOOK_TIMEOUT_MS);
  }

  public getWebhookMaxConsecutiveFailures(): number {
    return EnvParser.positiveInt(this.env, 'WEBHOOK_MAX_CONSECUTIVE_FAILURES', DEFAULT_WEBHOOK_MAX_CONSECUTIVE_FAILURES);
  }

  public getWebhookMaxPayloadBytes(): number {
    return EnvParser.positiveInt(this.env, 'WEBHOOK_MAX_PAYLOAD_BYTES', DEFAULT_WEBHOOK_MAX_PAYLOAD_BYTES);
  }

  public getMaxReleasesPerRepo(): number {
    return EnvParser.positiveInt(this.env, 'MAX_RELEASES_PER_REPO', DEFAULT_MAX_RELEASES_PER_REPO);
  }

  public getMaxAssetsPerRelease(): number {
    return EnvParser.positiveInt(this.env, 'MAX_ASSETS_PER_RELEASE', DEFAULT_MAX_ASSETS_PER_RELEASE);
  }

  public getMaxAssetBytes(): number {
    return EnvParser.positiveInt(this.env, 'MAX_ASSET_BYTES', DEFAULT_MAX_ASSET_BYTES);
  }

  public getMaxProjectsPerRepo(): number {
    return EnvParser.positiveInt(this.env, 'MAX_PROJECTS_PER_REPO', DEFAULT_MAX_PROJECTS_PER_REPO);
  }

  public getMaxColumnsPerProject(): number {
    return EnvParser.positiveInt(this.env, 'MAX_COLUMNS_PER_PROJECT', DEFAULT_MAX_COLUMNS_PER_PROJECT);
  }

  public getMaxCardsPerColumn(): number {
    return EnvParser.positiveInt(this.env, 'MAX_CARDS_PER_COLUMN', DEFAULT_MAX_CARDS_PER_COLUMN);
  }

  public getMaxDiscussionsPerRepo(): number {
    return EnvParser.positiveInt(this.env, 'MAX_DISCUSSIONS_PER_REPO', DEFAULT_MAX_DISCUSSIONS_PER_REPO);
  }

  public getMaxWikiPagesPerRepo(): number {
    return EnvParser.positiveInt(this.env, 'MAX_WIKI_PAGES_PER_REPO', DEFAULT_MAX_WIKI_PAGES_PER_REPO);
  }

  public getMaxWikiBodyBytes(): number {
    return EnvParser.positiveInt(this.env, 'MAX_WIKI_BODY_BYTES', DEFAULT_MAX_WIKI_BODY_BYTES);
  }

  public getMaxSnippetsPerUser(): number {
    return EnvParser.positiveInt(this.env, 'MAX_SNIPPETS_PER_USER', DEFAULT_MAX_SNIPPETS_PER_USER);
  }

  public getMaxFilesPerSnippet(): number {
    return EnvParser.positiveInt(this.env, 'MAX_FILES_PER_SNIPPET', DEFAULT_MAX_FILES_PER_SNIPPET);
  }

  public getMaxSnippetBytes(): number {
    return EnvParser.positiveInt(this.env, 'MAX_SNIPPET_BYTES', DEFAULT_MAX_SNIPPET_BYTES);
  }

  public getMaxTeamsPerOrg(): number {
    return EnvParser.positiveInt(this.env, 'MAX_TEAMS_PER_ORG', DEFAULT_MAX_TEAMS_PER_ORG);
  }

  public getMaxTeamMembers(): number {
    return EnvParser.positiveInt(this.env, 'MAX_TEAM_MEMBERS', DEFAULT_MAX_TEAM_MEMBERS);
  }

  public getMaxTeamGrants(): number {
    return EnvParser.positiveInt(this.env, 'MAX_TEAM_GRANTS', DEFAULT_MAX_TEAM_GRANTS);
  }

  public getMaxImportBytes(): number {
    return EnvParser.positiveInt(this.env, 'MAX_IMPORT_BYTES', DEFAULT_MAX_IMPORT_BYTES);
  }

  public getMaxImportRefs(): number {
    return EnvParser.positiveInt(this.env, 'MAX_IMPORT_REFS', DEFAULT_MAX_IMPORT_REFS);
  }

  public getMaxExportBytes(): number {
    return EnvParser.positiveInt(this.env, 'MAX_EXPORT_BYTES', DEFAULT_MAX_EXPORT_BYTES);
  }

  public getMaxDeployKeysPerRepo(): number {
    return EnvParser.positiveInt(this.env, 'MAX_DEPLOY_KEYS_PER_REPO', DEFAULT_MAX_DEPLOY_KEYS_PER_REPO);
  }

  public getMaxTokenRepoGrants(): number {
    return EnvParser.positiveInt(this.env, 'MAX_TOKEN_REPO_GRANTS', DEFAULT_MAX_TOKEN_REPO_GRANTS);
  }

  public getMaxMirrorFailures(): number {
    return EnvParser.positiveInt(this.env, 'MAX_MIRROR_FAILURES', DEFAULT_MAX_MIRROR_FAILURES);
  }

  public getImportClaimStaleSeconds(): number {
    return EnvParser.positiveInt(this.env, 'IMPORT_CLAIM_STALE_SECONDS', DEFAULT_IMPORT_CLAIM_STALE_SECONDS);
  }

  public getMaxChecksPerSha(): number {
    return EnvParser.positiveInt(this.env, 'MAX_CHECKS_PER_SHA', DEFAULT_MAX_CHECKS_PER_SHA);
  }

  public getCheckTimeoutSeconds(): number {
    return EnvParser.positiveInt(this.env, 'CHECK_TIMEOUT_SECONDS', DEFAULT_CHECK_TIMEOUT_SECONDS);
  }

  public getCheckRetentionDays(): number {
    return EnvParser.positiveInt(this.env, 'CHECK_RETENTION_DAYS', DEFAULT_CHECK_RETENTION_DAYS);
  }

  public isCheckCustomJsEnabled(): boolean {
    return EnvParser.boolean(this.env, 'CHECK_CUSTOMJS_ENABLED', DEFAULT_CHECK_CUSTOMJS_ENABLED);
  }

  public getCheckCustomJsMaxCpuMs(): number {
    return EnvParser.positiveInt(this.env, 'CHECK_CUSTOMJS_MAX_CPU_MS', DEFAULT_CHECK_CUSTOMJS_MAX_CPU_MS);
  }

  public getCheckCustomJsMaxScriptBytes(): number {
    return EnvParser.positiveInt(this.env, 'CHECK_CUSTOMJS_MAX_SCRIPT_BYTES', DEFAULT_CHECK_CUSTOMJS_MAX_SCRIPT_BYTES);
  }

  public getCheckCustomJsMaxFetches(): number {
    return EnvParser.positiveInt(this.env, 'CHECK_CUSTOMJS_MAX_FETCHES', DEFAULT_CHECK_CUSTOMJS_MAX_FETCHES);
  }

  public getCheckCustomJsMemoryMb(): number {
    return EnvParser.positiveInt(this.env, 'CHECK_CUSTOMJS_MEMORY_MB', DEFAULT_CHECK_CUSTOMJS_MEMORY_MB);
  }

  public isDemoMode(): boolean {
    return EnvParser.boolean(this.env, 'DEMO_MODE', 'false');
  }

  public isRealtimeEnabled(): boolean {
    return EnvParser.boolean(this.env, 'REALTIME_ENABLED', DEFAULT_REALTIME_ENABLED);
  }

  public getRealtimeTicketTtlSeconds(): number {
    return EnvParser.positiveInt(this.env, 'REALTIME_TICKET_TTL_SECONDS', DEFAULT_REALTIME_TICKET_TTL_SECONDS);
  }

  public getRealtimeMaxConnPerRepoShard(): number {
    return EnvParser.positiveInt(this.env, 'REALTIME_MAX_CONN_PER_REPO_SHARD', DEFAULT_REALTIME_MAX_CONN_PER_REPO_SHARD);
  }

  public getRealtimeMaxConnPerInboxShard(): number {
    return EnvParser.positiveInt(this.env, 'REALTIME_MAX_CONN_PER_INBOX_SHARD', DEFAULT_REALTIME_MAX_CONN_PER_INBOX_SHARD);
  }
}

export { AppConfiguration };
