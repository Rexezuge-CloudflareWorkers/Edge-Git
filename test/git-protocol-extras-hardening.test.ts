import { describe, expect, it } from 'vitest';
import {
  getBasicCredentials,
  getBearerToken,
  branchNameFromRef,
  buildUploadPackRequest,
  decodeUploadPackResponse,
  parseUploadPackAdvertisement,
  PktLine,
} from '@edge-git/git-protocol';

describe('AuthHeaders edges', () => {
  it('getBasicCredentials rejects malformed base64/user-only', () => {
    const req = (auth?: string) => new Request('https://x', { headers: auth ? { Authorization: auth } : {} });
    expect(getBasicCredentials(req())).toBeNull();
    expect(getBasicCredentials(req('Basic !!!'))).toBeNull();
    expect(getBasicCredentials(req('Bearer token123'))).toBeNull();
    const ok = getBasicCredentials(req(`Basic ${btoa('user:pass123')}`));
    expect(ok).toMatchObject({ username: 'user', password: 'pass123' });
  });

  it('getBearerToken rejects empty/malformed', () => {
    const req = (auth?: string) => new Request('https://x', { headers: auth ? { Authorization: auth } : {} });
    expect(getBearerToken(req())).toBeNull();
    expect(getBearerToken(req('Bearer '))).toBeNull();
    expect(getBearerToken(req('Basic abc'))).toBeNull();
    expect(getBearerToken(req('Bearer tok_123'))).toBe('tok_123');
  });
});

describe('branchNameFromRef', () => {
  it('strips refs/heads, null otherwise', () => {
    expect(branchNameFromRef('refs/heads/main')).toBe('main');
    expect(branchNameFromRef('refs/heads/feature/x')).toBe('feature/x');
    expect(branchNameFromRef('refs/tags/v1')).toBeNull();
    expect(branchNameFromRef('main')).toBeNull();
  });
});

describe('upload-pack request/response hardening', () => {
  it('buildUploadPackRequest rejects empty/invalid oids', () => {
    expect(() => buildUploadPackRequest([])).toThrow();
    expect(() => buildUploadPackRequest(['not-an-oid'])).toThrow();
    const oid = 'a'.repeat(40);
    expect(buildUploadPackRequest([oid]).length).toBeGreaterThan(0);
  });

  it('decodeUploadPackResponse drops progress, throws on error band', () => {
    const progress = PktLine.encode(new Uint8Array([2, ...new TextEncoder().encode('sideband progress')]));
    // Progress-only body has no pack → missing PACK header error.
    expect(() => decodeUploadPackResponse(progress, 1024)).toThrow();
    const errBand = PktLine.encode(new Uint8Array([3, ...new TextEncoder().encode('remote exploded')]));
    expect(() => decodeUploadPackResponse(errBand, 1024)).toThrow(/remote error/);
  });

  it('parseUploadPackAdvertisement skips NAK/non-heads/duplicates', () => {
    const oid = 'b'.repeat(40);
    const lines = [
      PktLine.encode('# service=git-upload-pack\n'),
      PktLine.encode('NAK\n'),
      PktLine.encode(`${oid} refs/heads/main\0multi_ack\n`),
      PktLine.encode(`${oid} refs/heads/main\n`),
      PktLine.encode(`${oid} refs/pull/1/head\n`),
      PktLine.encodeFlush(),
    ];
    const refs = parseUploadPackAdvertisement(PktLine.mergeLines(lines), 10);
    expect(refs).toEqual([{ ref: 'refs/heads/main', oid }]);
  });

  it('parseUploadPackAdvertisement enforces maxRefs', () => {
    const lines = [PktLine.encode(`${'c'.repeat(40)} refs/heads/a\n`), PktLine.encode(`${'d'.repeat(40)} refs/heads/b\n`)];
    expect(() => parseUploadPackAdvertisement(PktLine.mergeLines(lines), 1)).toThrow(/too many refs/);
  });
});
