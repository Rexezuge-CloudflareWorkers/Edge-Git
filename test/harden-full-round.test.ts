import { describe, expect, it } from 'vitest';
import { decodeRouteParam, parseContentLength, parseLimitParam } from '@/workers/routes/RouteInput';
import {
  isBlockedIpv6Host as sharedIsBlockedIpv6,
  isEncodedNumericHost as sharedIsEncodedNumeric,
  isLocalhostName,
  isLoopbackHost,
  isZeroGitOid,
  stripHostBrackets,
  stripHostTrailingDot,
} from '@edge-git/shared/utils';
import { ZERO_OID } from '@edge-git/shared/constants';
import {
  isBlockedIpv6Host as gitIsBlockedIpv6,
  isEncodedNumericHost as gitIsEncodedNumeric,
} from '@edge-git/git-protocol/GitUrlPolicy';
import { isZeroOid as protocolIsZeroOid } from '@edge-git/git-protocol/ProtectionPolicy';
import { isZeroOid as serviceIsZeroOid } from '@edge-git/git-service/RefValidation';
import { TokenService } from '@edge-git/backend-services/auth';
import { DatabaseError } from '@edge-git/backend-errors';

describe('harden full round: RouteInput fail-closed parsing', () => {
  it('decodes valid params and rejects malformed escapes with null (400, never 500)', () => {
    expect(decodeRouteParam('alice')).toBe('alice');
    expect(decodeRouteParam('a%40b.com')).toBe('a@b.com');
    expect(decodeRouteParam('%E0%A4%A')).toBeNull();
    expect(decodeRouteParam('%')).toBeNull();
  });

  it('parses limits with fallback instead of NaN coercion', () => {
    expect(parseLimitParam('10', 20, 50)).toBe(10);
    expect(parseLimitParam(null, 20, 50)).toBe(20);
    expect(parseLimitParam('', 20, 50)).toBe(20);
    expect(parseLimitParam('NaN', 20, 50)).toBe(20);
    expect(parseLimitParam('abc', 20, 50)).toBe(20);
    expect(parseLimitParam('0', 20, 50)).toBe(20);
    expect(parseLimitParam('999', 20, 50)).toBe(20);
  });

  it('parses Content-Length fail-closed: missing/malformed defers to the body check', () => {
    expect(parseContentLength(null)).toBeNull();
    expect(parseContentLength('')).toBeNull();
    expect(parseContentLength('123')).toBe(123);
    expect(parseContentLength('NaN')).toBeNull();
    expect(parseContentLength('-5')).toBeNull();
    expect(parseContentLength('12.5')).toBeNull();
  });
});

describe('harden full round: canonical SSRF helpers stay in parity', () => {
  it('shared and git-protocol predicates agree on hostile hosts', () => {
    const hostile = ['0x7f000001', '12345', '::ffff:7f00:1', 'fc00::1', 'fe80::1', 'ff02::1'];
    for (const host of hostile) {
      expect(sharedIsEncodedNumeric(host) || sharedIsBlockedIpv6(host)).toBe(true);
    }
    expect(gitIsEncodedNumeric('0x7f000001')).toBe(sharedIsEncodedNumeric('0x7f000001'));
    expect(gitIsBlockedIpv6('fc00::1')).toBe(sharedIsBlockedIpv6('fc00::1'));
    expect(isLocalhostName('LOCALHOST')).toBe(true);
    expect(isLocalhostName('a.localhost')).toBe(true);
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true);
    expect(stripHostBrackets('[::1]')).toBe('::1');
    expect(stripHostTrailingDot('example.com...')).toBe('example.com');
  });
});

describe('harden full round: canonical zero-OID stays in parity', () => {
  it('shared, protocol, and service agree on create/delete sentinels', () => {
    expect(isZeroGitOid(ZERO_OID)).toBe(true);
    expect(isZeroGitOid('abc')).toBe(false);
    expect(isZeroGitOid(undefined)).toBe(false);
    expect(protocolIsZeroOid(ZERO_OID)).toBe(true);
    expect(serviceIsZeroOid(ZERO_OID)).toBe(true);
    expect(protocolIsZeroOid('abc')).toBe(serviceIsZeroOid('abc'));
  });
});

describe('harden full round: TokenService grant resolution fails closed', () => {
  it('D1 outage during grant lookup propagates instead of masking as 404', async () => {
    const svc = new TokenService({ DB: {} as never }, {
      tokenDAO: () => Promise.resolve({ getByUserEmail: async () => [] } as never),
      repositoryDAO: () =>
        Promise.resolve({
          getByOwnerAndName: async () => {
            throw new DatabaseError('D1 down');
          },
        } as never),
      tokenGrantDAO: () => Promise.resolve({} as never),
    });
    await expect(
      svc.createToken('a@example.com', 'scoped', 30, ['repo:read'], [{ owner: 'a', name: 'r', scope: 'repo:read' }]),
    ).rejects.toThrow(DatabaseError);
  });

  it('genuinely-missing repos still map to NotFound', async () => {
    const svc = new TokenService({ DB: {} as never }, {
      tokenDAO: () => Promise.resolve({ getByUserEmail: async () => [] } as never),
      repositoryDAO: () => Promise.resolve({ getByOwnerAndName: async () => null } as never),
      tokenGrantDAO: () => Promise.resolve({} as never),
    });
    await expect(
      svc.createToken('a@example.com', 'scoped', 30, ['repo:read'], [{ owner: 'ghost', name: 'missing', scope: 'repo:read' }]),
    ).rejects.toThrow(/not found/i);
  });
});
