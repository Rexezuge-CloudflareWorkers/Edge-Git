import { describe, expect, it } from 'vitest';
import { channelForRepoEvent } from '@/workers/routes/SocialEmit';
import { decodeMemberParam, normalizeMemberTarget } from '@/workers/routes/TeamRoutes';
import { presentOne } from '@/workers/routes/IdentityPresenter';
import { ErrorSanitizationUtil } from '@edge-git/shared/utils';

// Single-commit hardening: orphan cleanup + fail-closed fixes + secret-safe logs.
// Patterns: Strategy (decode/normalize helpers), Observer (best-effort fan-out),
// Facade (presentOne), Policy (channel mapping).
describe('harden cleanup single: TeamRoutes member helpers', () => {
  it('decodeMemberParam guards URIError instead of throwing 500', () => {
    expect(decodeMemberParam('alice')).toBe('alice');
    expect(decodeMemberParam('a%20b')).toBe('a b');
    expect(decodeMemberParam('%')).toBeNull();
    expect(decodeMemberParam('%E0%A4%A')).toBeNull();
  });

  it('normalizeMemberTarget trims and lowercases emails only', () => {
    expect(normalizeMemberTarget('  Foo@Bar.COM  ')).toBe('foo@bar.com');
    expect(normalizeMemberTarget('  Alice  ')).toBe('Alice');
    expect(normalizeMemberTarget('   ')).toBe('');
  });
});

describe('harden cleanup single: SocialEmit channel policy', () => {
  it('scopes issue/pull subjects, defaults everything else to activity', () => {
    expect(channelForRepoEvent('issue_opened', 'issue', 12)).toBe('issue:12');
    expect(channelForRepoEvent('pr_merged', 'pull', 34)).toBe('pr:34');
    expect(channelForRepoEvent('push', null, null)).toBe('activity');
    expect(channelForRepoEvent('push', 'issue', null)).toBe('activity');
    expect(channelForRepoEvent('push', 'issue', Number.NaN)).toBe('activity');
    expect(channelForRepoEvent('push', 'issue', Number.MAX_SAFE_INTEGER + 1)).toBe('activity');
    expect(channelForRepoEvent('push', 'project', 3)).toBe('activity');
  });
});

describe('harden cleanup single: secret-safe logging', () => {
  it('redacts PATs and bearer tokens before logging', () => {
    const msg = ErrorSanitizationUtil.sanitizeErrorForLogging(new Error('failed with edge-git-pat:abc123'));
    expect(msg).not.toContain('abc123');
    expect(msg).toContain('[REDACTED-PAT]');
    expect(ErrorSanitizationUtil.sanitizeMessage('auth Bearer secret-token-xyz')).toContain('[REDACTED]');
  });
});

describe('harden cleanup single: IdentityPresenter still redacts without barrel', () => {
  it('maps emails to usernames and drops raw keys', () => {
    const out = presentOne({ creator_email: 'a@x.co' } as never, new Map([['a@x.co', 'alice']]));
    expect(out['creator']).toBe('alice');
    expect('creator_email' in out).toBe(false);
  });
});
