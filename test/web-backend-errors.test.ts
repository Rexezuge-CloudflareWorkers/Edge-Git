import { describe, expect, it } from 'vitest';
import { BackendError, getBackendErrorStatus, getBackendErrorType, readJson } from '../apps/web/src/lib/api';
import { BACKEND_TYPE_TO_I18N_KEY, toLocalizedErrorMessage } from '../apps/web/src/lib/backendErrors';

function fakeT(calls: Array<{ key: string; fallback: string }>) {
  return (key: string, fallback: string): string => {
    calls.push({ key, fallback });
    return `${key}|${fallback}`;
  };
}

function envelope(type: string, message: string): Response {
  return new Response(JSON.stringify({ Exception: { Type: type, Message: message } }), { status: 403 });
}

describe('BackendError (web api)', () => {
  it('preserves the backend Exception type and HTTP status', async () => {
    const failure = await readJson(envelope('Forbidden', 'Access Denied.')).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(BackendError);
    expect(getBackendErrorType(failure)).toBe('Forbidden');
    expect(getBackendErrorStatus(failure)).toBe(403);
    expect((failure as Error).message).toBe('Access Denied.');
  });

  it('returns null type/status for plain errors', () => {
    expect(getBackendErrorType(new Error('boom'))).toBeNull();
    expect(getBackendErrorStatus(new Error('boom'))).toBeNull();
    expect(getBackendErrorType(null)).toBeNull();
  });

  it('resolves JSON bodies on success', async () => {
    const ok = new Response(JSON.stringify({ hello: 'world' }), { status: 200 });
    await expect(readJson<{ hello: string }>(ok)).resolves.toEqual({ hello: 'world' });
  });
});

describe('toLocalizedErrorMessage', () => {
  it('maps every known backend type to its errors.backend key', () => {
    for (const [type, key] of Object.entries(BACKEND_TYPE_TO_I18N_KEY)) {
      const calls: Array<{ key: string; fallback: string }> = [];
      const message = toLocalizedErrorMessage(fakeT(calls), new BackendError('raw english', type, 400), 'errors.failedToLoad', 'Fallback.');
      expect(calls).toHaveLength(1);
      expect(calls[0]?.key).toBe(key);
      expect(message.startsWith(`${key}|`)).toBe(true);
    }
  });

  it('falls back to the operation message for unknown types and untyped errors', () => {
    for (const error of [new BackendError('raw', 'SomethingElse', 400), new Error('network down'), null]) {
      const calls: Array<{ key: string; fallback: string }> = [];
      const message = toLocalizedErrorMessage(fakeT(calls), error, 'errors.failedToLoadTokens', 'Failed To Load Tokens.');
      expect(message).toBe('errors.failedToLoadTokens|Failed To Load Tokens.');
    }
  });
});
