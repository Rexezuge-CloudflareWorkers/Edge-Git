import { describe, expect, it } from 'vitest';
import { AuthConfig } from '@edge-git/backend-runtime/config/sections/AuthConfig';
import { AppConfiguration } from '@edge-git/backend-runtime/config/AppConfiguration';
import { CronTasksWorker } from '@edge-git/background/CronTasksWorker';

describe('coverage push: AuthConfig', () => {
  it('defaults to production (bypass denied)', () => {
    const c = new AuthConfig({});
    expect(c.getEnvironment()).toBe('production');
    expect(c.isBypassAllowed()).toBe(false);
    expect(c.isDemoMode()).toBe(false);
    expect(c.getDevAuthEmail()).toBeNull();
    expect(c.getTeamDomain()).toBeNull();
    expect(c.getPolicyAud()).toBeNull();
    expect(c.getDemoUserEmail()).toBeNull();
  });

  it('allows bypass in development', () => {
    const c = new AuthConfig({ ENVIRONMENT: 'development', DEMO_MODE: 'true', DEV_AUTH_EMAIL: 'a@b.co', TEAM_DOMAIN: 'https://x', POLICY_AUD: 'aud', DEMO_USER_EMAIL: 'd@e.co' });
    expect(c.getEnvironment()).toBe('development');
    expect(c.isBypassAllowed()).toBe(true);
    expect(c.isDemoMode()).toBe(true);
    expect(c.getDevAuthEmail()).toBe('a@b.co');
    expect(c.getTeamDomain()).toBe('https://x');
    expect(c.getPolicyAud()).toBe('aud');
    expect(c.getDemoUserEmail()).toBe('d@e.co');
  });

  it('trims empty env to defaults', () => {
    const c = new AuthConfig({ ENVIRONMENT: '  ' });
    expect(c.getEnvironment()).toBe('production');
  });
});

describe('coverage push: AppConfiguration git limits', () => {
  it('reads git limits with defaults and overrides', () => {
    const d = new AppConfiguration({});
    expect(d.getMaxPushCommands()).toBeGreaterThan(0);
    expect(d.getMaxPackBytes()).toBeGreaterThan(0);
    expect(d.getMaxFetchBodyBytes()).toBeGreaterThan(0);
    expect(d.getMaxPackObjects()).toBeGreaterThan(0);
    const o = new AppConfiguration({ MAX_PUSH_COMMANDS: '11', MAX_PACK_BYTES: '13', MAX_FETCH_BODY_BYTES: '14', MAX_PACK_OBJECTS: '15' });
    expect(o.getMaxPushCommands()).toBe(11);
    expect(o.getMaxPackBytes()).toBe(13);
  });
});

describe('coverage push: CronTasksWorker', () => {
  it('404s non-/run and handles single-flight', async () => {
    const w = Object.create(CronTasksWorker.prototype) as InstanceType<typeof CronTasksWorker>;
    const notFound = await (w as unknown as { fetch(r: Request): Promise<Response> }).fetch(new Request('https://do/nope', { method: 'GET' }));
    expect(notFound.status).toBe(404);
    // single-flight: set currentRun then fetch /run POST → 202 Already running
    (w as unknown as { currentRun: Promise<void> | null }).currentRun = Promise.resolve();
    // need ctx/env for fetch? fetch checks pathname first, then currentRun before touching env.
    const busy = await (w as unknown as { fetch(r: Request): Promise<Response> }).fetch(new Request('https://do/run', { method: 'POST' }));
    expect(busy.status).toBe(202);
  });
});
