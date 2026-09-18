import { describe, expect, it } from 'vitest';
import { normalizePublicGitUrl, resolveRedirectUrl, MAX_REDIRECTS } from '@edge-git/git-protocol';
import { validateWebhookUrl, resolveWebhookRedirect } from '@edge-git/backend-services/webhook/WebhookEvents';

describe('import SSRF redirect re-validation', () => {
  it('exposes a redirect budget', () => {
    expect(MAX_REDIRECTS).toBe(3);
  });

  it('allows same-origin https redirects', () => {
    const next = resolveRedirectUrl('https://github.com/a/b', '/a/b.git');
    expect(next).toContain('https://github.com/a/b');
  });

  it('rejects redirects to localhost/private/encoded hosts', () => {
    for (const target of [
      'https://localhost/evil.git',
      'https://127.0.0.1/evil.git',
      'https://10.0.0.1/evil.git',
      'https://169.254.169.254/evil.git',
      'https://[::ffff:127.0.0.1]/evil.git',
      'http://github.com/a/b.git',
    ]) {
      expect(() => resolveRedirectUrl('https://github.com/a/b', target), target).toThrow();
    }
  });

  it('rejects empty/invalid redirect locations', () => {
    expect(() => resolveRedirectUrl('https://github.com/a/b', '')).toThrow();
    expect(() => resolveRedirectUrl('https://github.com/a/b', 'https://')).toThrow();
  });

  it('normalizePublicGitUrl matrix: blocked hosts', () => {
    for (const bad of [
      'https://localhost/x.git',
      'https://localhost./x.git',
      'https://foo.localhost/x.git',
      'https://127.1.2.3/x.git',
      'https://10.1.2.3/x.git',
      'https://172.16.5.4/x.git',
      'https://192.168.1.1/x.git',
      'https://169.254.169.254/x.git',
      'https://100.64.0.1/x.git',
      'https://0.0.0.0/x.git',
      'https://user:pass@github.com/a/b.git',
      'http://github.com/a/b.git',
      'https://github.com',
    ]) {
      expect(() => normalizePublicGitUrl(bad), bad).toThrow();
    }
  });

  it('normalizePublicGitUrl strips query/fragment/trailing slash, keeps .git', () => {
    expect(normalizePublicGitUrl('https://github.com/a/b.git/?x=1#frag')).toBe('https://github.com/a/b.git');
    expect(normalizePublicGitUrl('https://github.com/a/b/')).toBe('https://github.com/a/b');
  });
});

describe('webhook redirect re-validation', () => {
  it('allows https same-host redirects', () => {
    expect(resolveWebhookRedirect('https://hooks.example.com/a', '/b')).toBe('https://hooks.example.com/b');
  });

  it('rejects redirects to private/loopback hosts', () => {
    for (const target of [
      'http://localhost/hook',
      'https://127.0.0.1/hook',
      'https://10.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/hook',
    ]) {
      expect(() => resolveWebhookRedirect('https://hooks.example.com/a', target), target).toThrow();
    }
  });

  it('rejects credentialed and empty redirects', () => {
    expect(() => resolveWebhookRedirect('https://hooks.example.com/a', '')).toThrow();
    expect(() => resolveWebhookRedirect('https://hooks.example.com/a', 'https://user:pw@hooks.example.com/b')).toThrow();
  });

  it('validateWebhookUrl still rejects non-http(s)', () => {
    expect(() => validateWebhookUrl('ftp://example.com/hook')).toThrow();
    expect(() => validateWebhookUrl('')).toThrow();
  });
});
