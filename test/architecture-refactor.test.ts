import { describe, expect, it } from 'vitest';
import { canonicalizeLanguageTag } from '@edge-git/shared/utils';
import { canonicalizeBackendLocaleTag, getBackendStrings } from '@edge-git/shared/i18n';
import { assetNameSchema, branchNameSchema, repoNameSchema, teamSlugSchema, usernameSchema } from '@edge-git/shared/validation';
import { RoleRank } from '@edge-git/backend-services/permission';
import { hideExistence, mapServiceError, toServiceStatus } from '@edge-git/backend-services/errors';
import { BadRequestError, NotFoundError } from '@edge-git/backend-errors';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
import { resolveSandboxLimits } from '../apps/background/src/checks/SandboxLimits';

describe('refactor: shared kernel', () => {
  it('canonicalizes language tags from a single source', () => {
    expect(canonicalizeLanguageTag('en_us')).toBe('en-US');
    expect(canonicalizeLanguageTag('zh')).toBe('zh');
    expect(canonicalizeBackendLocaleTag('en_us')).toBe(canonicalizeLanguageTag('en_us'));
  });

  it('exposes internalError strings in both locales', () => {
    expect(getBackendStrings('en').common.internalError).toBe('Internal Server Error.');
    expect(getBackendStrings('zh-CN').common.internalError).toBeTruthy();
  });

  it('validates names via shared zod schemas', () => {
    expect(usernameSchema.safeParse('octo-cat').success).toBe(true);
    expect(usernameSchema.safeParse('-bad-').success).toBe(false);
    expect(usernameSchema.safeParse('').success).toBe(false);
    expect(teamSlugSchema.safeParse('team-1').success).toBe(true);
    expect(repoNameSchema.safeParse('my.repo-1').success).toBe(true);
    expect(repoNameSchema.safeParse('').success).toBe(false);
    expect(branchNameSchema.safeParse('feature/x').success).toBe(true);
    expect(branchNameSchema.safeParse('a..b').success).toBe(false);
    expect(assetNameSchema.safeParse('app.zip').success).toBe(true);
  });
});

describe('refactor: policy objects + error mapper', () => {
  it('ranks roles via a single value object', () => {
    expect(RoleRank.meets('write', 'read')).toBe(true);
    expect(RoleRank.meets('read', 'write')).toBe(false);
    expect(RoleRank.meets(null, 'read')).toBe(false);
    expect(RoleRank.rank('admin')).toBe(3);
  });

  it('maps service errors centrally', () => {
    const mapped = mapServiceError(new NotFoundError('nope'));
    expect(mapped.status).toBe(404);
    expect(mapped.body.error).toBeTruthy();
    const internal = mapServiceError(new Error('boom'), 'zh-CN');
    expect(internal.status).toBe(500);
    expect(internal.body.message).toBe(getBackendStrings('zh-CN').common.internalError);
    expect(toServiceStatus(new BadRequestError('bad'))).toBe(400);
    expect(toServiceStatus(new Error('boom'))).toBe(500);
  });

  it('hides existence explicitly instead of scattered catch(()=>null)', async () => {
    await expect(hideExistence(async () => 'ok')).resolves.toBe('ok');
    await expect(
      hideExistence(async () => {
        throw new NotFoundError('gone');
      }),
    ).resolves.toBeNull();
  });
});

describe('refactor: config composition', () => {
  it('delegates manager statics to AppConfiguration sections', () => {
    const env = { MAX_REPOS_PER_USER: '7', MAX_HOOKS_PER_REPO: '3' };
    const config = AppConfiguration.fromEnv(env);
    expect(config.getMaxReposPerUser()).toBe(7);
    expect(config.repo.getMaxReposPerUser()).toBe(7);
    expect(config.getMaxHooksPerRepo()).toBe(3);
    expect(config.webhook.getMaxHooksPerRepo()).toBe(3);
    expect(config.getDevAuthEmail()).toBeNull();
    expect(AppConfiguration.fromEnv({ DEV_AUTH_EMAIL: 'dev@example.com' }).getDevAuthEmail()).toBe('dev@example.com');
  });

  it('resolves sandbox limits from injected config', () => {
    const config = AppConfiguration.fromEnv({});
    const limits = resolveSandboxLimits(config, { cpuMs: 123 });
    expect(limits.cpuMs).toBe(123);
    expect(limits.maxFetches).toBe(config.getCheckCustomJsMaxFetches());
  });
});
