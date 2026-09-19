import { describe, expect, it } from 'vitest';
import { toSafeErrorMessage, toServiceStatus } from '@/workers/routes/PublicViewerResolver';
import { BadRequestError, NotFoundError } from '@edge-git/backend-errors';

describe('error masking sweep', () => {
  it('masks 500 internals with fallback', () => {
    const d1 = new Error('D1_ERROR: no such table: user_access_tokens near "FOO"');
    expect(toServiceStatus(d1)).toBe(500);
    expect(toSafeErrorMessage(d1, 'Failed to list')).toBe('Failed to list');
    expect(toSafeErrorMessage(d1, 'Failed')).not.toContain('D1_ERROR');
  });

  it('preserves client-error messages', () => {
    expect(toSafeErrorMessage(new BadRequestError('name is required'), 'Failed')).toBe('name is required');
    expect(toSafeErrorMessage(new NotFoundError('Not found'), 'Failed')).toBe('Not found');
  });

  it('falls back on empty messages', () => {
    expect(toSafeErrorMessage(new Error(''), 'Failed to sync fork')).toBe('Failed to sync fork');
    expect(toSafeErrorMessage('string boom', 'Merge failed')).toBe('Merge failed');
  });

  it('never leaks stack traces via fallback path', () => {
    const withStack = new Error('boom');
    withStack.stack = 'Error: boom\n    at D1.query (internal.js:1:1)\n    at secret-do-path';
    const out = toSafeErrorMessage(withStack, 'Internal error');
    expect(out).toBe('Internal error');
  });
});
