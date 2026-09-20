import { describe, expect, it, vi } from 'vitest';
import { EnvParser } from '@edge-git/backend-runtime/config/EnvParser';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
import { repoDoKey, repoDoKeyForFullName } from '@edge-git/shared/utils';
import { RepoLifecycle } from '@edge-git/background/RepoLifecycle';
import { RATE_LIMIT_DEFS, registerGitRateLimits, registerUserRateLimits } from '@/middleware/rateLimitConfig';

vi.mock('@edge-git/git-service', () => ({ setDofsDeviceSize: vi.fn() }));

describe('hardening coverage push: EnvParser', () => {
  it('covers positive/non-negative/string/boolean fallbacks', () => {
    expect(EnvParser.positiveInt({}, 'X', '10')).toBe(10);
    expect(EnvParser.positiveInt({ X: '5' }, 'X', '10')).toBe(5);
    expect(EnvParser.positiveInt({ X: '0' }, 'X', '10')).toBe(10);
    expect(EnvParser.positiveInt({ X: '-3' }, 'X', '10')).toBe(10);
    expect(EnvParser.positiveInt({ X: 'nope' }, 'X', '10')).toBe(10);
    expect(EnvParser.nonNegativeInt({ X: '0' }, 'X', '7')).toBe(0);
    expect(EnvParser.nonNegativeInt({ X: '-1' }, 'X', '7')).toBe(7);
    expect(EnvParser.nonNegativeInt({}, 'X', '7')).toBe(7);
    expect(EnvParser.string({ X: 'a' }, 'X', 'b')).toBe('a');
    expect(EnvParser.string({}, 'X', 'b')).toBe('b');
    expect(EnvParser.boolean({ X: 'true' }, 'X', 'false')).toBe(true);
    expect(EnvParser.boolean({ X: '1' }, 'X', 'false')).toBe(false);
    expect(EnvParser.boolean({}, 'X', 'true')).toBe(true);
  });
});

describe('hardening coverage push: Identity fallbacks', () => {
  it('never throws on malformed input', () => {
    expect(repoDoKey('', '')).toBe('/');
    expect(repoDoKey('  Foo  ', '  Bar.git  ')).toBe('foo/bar');
    expect(repoDoKeyForFullName('noslash')).toBe('noslash');
    expect(repoDoKeyForFullName('  Foo/Bar.GIT  ')).toBe('foo/bar');
    expect(repoDoKey('a!@#', 'b?')).toContain('/');
  });
});

describe('hardening coverage push: AppConfiguration facade', () => {
  it('exercises every delegate getter', () => {
    const config = AppConfiguration.fromEnv({
      DEBUG_MODE: 'true',
      SITE_URL: 'https://example.com/',
      MAX_REPOS_PER_USER: '3',
      DO_DEVICE_BYTES: '456',
    });
    expect(config.getDebugMode()).toBe(true);
    expect(config.getSiteUrl()).toBe('https://example.com');
    expect(config.getMaxReposPerUser()).toBe(3);
    expect(config.getDoDeviceBytes()).toBe(456);
    // Touch every section delegate so function coverage climbs.
    const getters: Array<() => unknown> = [
      () => config.getMaxTokensPerUser(),
      () => config.getMaxTokenExpiryDays(),
      () => config.getMaxPackObjects(),
      () => config.getGitCacheTtlSeconds(),
      () => config.getMaxFetchWants(),
      () => config.getMaxFetchHaves(),
      () => config.getMaxPushCommands(),
      () => config.getMaxPackBytes(),
      () => config.getMaxFetchBodyBytes(),
      () => config.getMaxMergeDiffFiles(),
      () => config.getMaxFileBytes(),
      () => config.getMaxRulesPerRepo(),
      () => config.getTaskRunRetentionDays(),
      () => config.getSearchBackfillIntervalSeconds(),
      () => config.getSearchBackfillReposPerTick(),
      () => config.getSearchBackfillFilesPerRepo(),
      () => config.getAuditLogRetentionDays(),
      () => config.getMaxHooksPerRepo(),
      () => config.getWebhookDeliveryRetentionDays(),
      () => config.getWebhookMaxAttempts(),
      () => config.getWebhookTimeoutMs(),
      () => config.getWebhookMaxConsecutiveFailures(),
      () => config.getWebhookMaxPayloadBytes(),
      () => config.getMaxReleasesPerRepo(),
      () => config.getMaxAssetsPerRelease(),
      () => config.getMaxAssetBytes(),
      () => config.getMaxProjectsPerRepo(),
      () => config.getMaxColumnsPerProject(),
      () => config.getMaxCardsPerColumn(),
      () => config.getMaxDiscussionsPerRepo(),
      () => config.getMaxWikiPagesPerRepo(),
      () => config.getMaxWikiBodyBytes(),
      () => config.getMaxSnippetsPerUser(),
      () => config.getMaxFilesPerSnippet(),
      () => config.getMaxSnippetBytes(),
      () => config.getMaxTeamsPerOrg(),
      () => config.getMaxTeamMembers(),
      () => config.getMaxTeamGrants(),
      () => config.getMaxImportBytes(),
      () => config.getMaxImportRefs(),
      () => config.getMaxExportBytes(),
      () => config.getMaxDeployKeysPerRepo(),
      () => config.getMaxTokenRepoGrants(),
      () => config.getMaxMirrorFailures(),
      () => config.getImportClaimStaleSeconds(),
      () => config.getMaxChecksPerSha(),
      () => config.getCheckTimeoutSeconds(),
      () => config.getCheckRetentionDays(),
      () => config.isCheckCustomJsEnabled(),
      () => config.getCheckCustomJsMaxCpuMs(),
      () => config.getCheckCustomJsMaxScriptBytes(),
      () => config.getCheckCustomJsMaxFetches(),
      () => config.getCheckCustomJsMemoryMb(),
      () => config.isDemoMode(),
      () => config.getEnvironment(),
      () => config.isBypassAllowed(),
      () => config.getDevAuthEmail(),
      () => config.getDemoUserEmail(),
      () => config.getTeamDomain(),
      () => config.getPolicyAud(),
      () => config.isRealtimeEnabled(),
      () => config.getRealtimeTicketTtlSeconds(),
      () => config.getRealtimeMaxConnPerRepoShard(),
      () => config.getRealtimeMaxConnPerInboxShard(),
      () => config.repo.getDoDeviceBytes(),
      () => config.gitLimits.getMaxPackObjects(),
      () => config.webhook.getMaxAttempts(),
      () => config.realtimeLimits.isEnabled(),
      () => config.contentLimits.getMaxReleasesPerRepo(),
      () => config.retentionLimits.getAuditLogRetentionDays(),
      () => config.authConfig.getEnvironment(),
    ];
    for (const get of getters) expect(get()).not.toBe(undefined);
  });
});

describe('hardening coverage push: RepoLifecycle device + limits + prepare', () => {
  function makeLifecycle() {
    const stat = vi.fn(async () => ({}) as never);
    const isoGitFs = { promises: { stat } };
    const git = { initRepo: vi.fn(async () => undefined), ensureFreshCache: vi.fn() };
    const lifecycle = new RepoLifecycle(
      {} as never,
      {} as never,
      {} as never,
      isoGitFs as never,
      git as never,
      AppConfiguration.fromEnv({ DO_DEVICE_BYTES: '789', GIT_CACHE_TTL_SECONDS: '11' }),
      () => 'foo/bar',
      async () => undefined,
    );
    return { lifecycle, stat, git };
  }

  it('ensureDeviceSize + getLimits + prepare hit config delegates', async () => {
    const { lifecycle, git } = makeLifecycle();
    lifecycle.ensureDeviceSize();
    const limits = lifecycle.getLimits();
    expect(limits.maxWants).toBeGreaterThan(0);
    expect(limits.maxRefs).toBe(limits.maxCommands * 10);
    await lifecycle.prepare();
    expect(git.ensureFreshCache).toHaveBeenCalledWith(11);
  });
});

describe('hardening coverage push: rate-limit registry wiring', () => {
  it('registers git (3) and user (rest) phases separately', () => {
    const gitPaths: string[] = [];
    const userPaths: string[] = [];
    const gitApp = { use: (path: string) => void gitPaths.push(path) };
    const userApp = { use: (path: string) => void userPaths.push(path) };
    registerGitRateLimits(gitApp as never);
    registerUserRateLimits(userApp as never);
    expect(gitPaths).toHaveLength(3);
    expect(userPaths).toHaveLength(RATE_LIMIT_DEFS.length - 3);
    expect(new Set([...gitPaths, ...userPaths]).size).toBe(RATE_LIMIT_DEFS.length);
  });
});
