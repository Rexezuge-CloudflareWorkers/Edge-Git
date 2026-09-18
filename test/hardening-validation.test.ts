import { describe, expect, it } from 'vitest';
import {
  clampAuditLimit,
  decodeBase64Strict,
  normalizeAssetContentType,
  parsePositiveInt,
  sanitizeCommitMessage,
  tokenIdSchema,
  truncateAuditFilter,
} from '@edge-git/shared/validation';
import { parsePullNumber } from '@/workers/routes/PullShared';
import { parseNumber as parseCollabNumber } from '@/workers/routes/collab/CollabHelpers';
import { readJsonBody } from '@/workers/routes/BodyParser';
import { toSafeErrorMessage, toServiceStatus } from '@/workers/routes/PublicViewerResolver';
import { BadRequestError, NotFoundError } from '@edge-git/backend-errors';

describe('parsePositiveInt hardening', () => {
  it('accepts normal ids', () => {
    expect(parsePositiveInt('1')).toBe(1);
    expect(parsePositiveInt(' 42 ')).toBe(42);
  });

  it('rejects zero, negative, non-numeric, huge', () => {
    expect(parsePositiveInt(undefined)).toBeNull();
    expect(parsePositiveInt('')).toBeNull();
    expect(parsePositiveInt('0')).toBeNull();
    expect(parsePositiveInt('-1')).toBeNull();
    expect(parsePositiveInt('1.5')).toBeNull();
    expect(parsePositiveInt('abc')).toBeNull();
    expect(parsePositiveInt('0x10')).toBeNull();
    expect(parsePositiveInt('99999999999999999999')).toBeNull();
    expect(parsePositiveInt('2147483648')).toBeNull();
  });

  it('unifies pull/collab parsers', () => {
    expect(parsePullNumber('0')).toBeNull();
    expect(parsePullNumber('-3')).toBeNull();
    expect(parsePullNumber('12')).toBe(12);
    expect(parseCollabNumber('0')).toBeNull();
    expect(parseCollabNumber('7')).toBe(7);
  });
});

describe('token id validation', () => {
  it('rejects raw ids before DAO', () => {
    expect(tokenIdSchema.safeParse('not-a-uuid').success).toBe(false);
    expect(tokenIdSchema.safeParse('123').success).toBe(false);
    expect(tokenIdSchema.safeParse(crypto.randomUUID()).success).toBe(true);
  });
});

describe('audit query caps', () => {
  it('clamps limit and truncates filters', () => {
    expect(clampAuditLimit(0)).toBeUndefined();
    expect(clampAuditLimit(5)).toBe(5);
    expect(clampAuditLimit(9999)).toBe(100);
    expect(truncateAuditFilter('  hello  ')).toBe('hello');
    expect(truncateAuditFilter('x'.repeat(500))?.length).toBe(200);
    expect(truncateAuditFilter('')).toBeUndefined();
  });
});

describe('commit message sanitization', () => {
  it('strips control chars and caps at 1000', () => {
    expect(sanitizeCommitMessage('hello\x00\x1fworld', 'fallback')).toBe('helloworld');
    expect(sanitizeCommitMessage('   ', 'fallback')).toBe('fallback');
    expect(sanitizeCommitMessage('x'.repeat(2000), 'fallback').length).toBe(1000);
    expect(sanitizeCommitMessage('Update  file', 'fallback')).toBe('Update file');
  });
});

describe('strict base64', () => {
  it('rejects whitespace tricks and bad padding', () => {
    expect(decodeBase64Strict('aGVsbG8=')).not.toBeNull();
    expect(decodeBase64Strict('aGVsbG8=   ')).not.toBeNull();
    expect(decodeBase64Strict('%%%')).toBeNull();
    expect(decodeBase64Strict('a')).toBeNull();
    expect(decodeBase64Strict('')).toBeNull();
  });
});

describe('asset content type normalization', () => {
  it('allow-lists safe types and neutralizes html/svg', () => {
    expect(normalizeAssetContentType('application/zip')).toBe('application/zip');
    expect(normalizeAssetContentType('text/html')).toBe('application/octet-stream');
    expect(normalizeAssetContentType('image/svg+xml')).toBe('application/octet-stream');
    expect(normalizeAssetContentType('text/html; charset=utf-8')).toBe('application/octet-stream');
    expect(normalizeAssetContentType('not-a-type')).toBe('application/octet-stream');
    expect(normalizeAssetContentType(undefined)).toBe('application/octet-stream');
  });
});

describe('readJsonBody malformed distinction', () => {
  it('flags invalid JSON instead of collapsing to {}', async () => {
    const malformed = { req: { json: async () => Promise.reject(new SyntaxError('bad')) } };
    await expect(readJsonBody(malformed as never)).resolves.toMatchObject({ malformed: true });
    const ok = { req: { json: async () => ({ name: 'x' }) } };
    await expect(readJsonBody<{ name: string }>(ok as never)).resolves.toMatchObject({
      malformed: false,
      body: { name: 'x' },
    });
  });
});

describe('error masking', () => {
  it('hides 500 internals but preserves 4xx messages', () => {
    expect(toServiceStatus(new BadRequestError('bad input'))).toBe(400);
    expect(toSafeErrorMessage(new BadRequestError('bad input'), 'Failed')).toBe('bad input');
    expect(toSafeErrorMessage(new NotFoundError('missing'), 'Not found')).toBe('missing');
    expect(toSafeErrorMessage(new Error('D1_ERROR: table users missing'), 'Failed')).toBe('Failed');
  });
});
