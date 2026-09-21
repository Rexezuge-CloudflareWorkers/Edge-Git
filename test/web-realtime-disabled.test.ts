import { describe, expect, it } from 'vitest';
import { REALTIME_DISABLED_MESSAGE, isRealtimeDisabledError } from '../apps/web/src/services/realtimeService';
import { isRealtimeDisabled, resetRealtimeDisabledForTesting } from '../apps/web/src/realtime/useRealtime';

describe('realtime disabled fallback', () => {
  it('matches the API disabled payload with or without trailing period', () => {
    expect(REALTIME_DISABLED_MESSAGE).toBe('Realtime is disabled');
    expect(isRealtimeDisabledError(new Error('Realtime is disabled'))).toBe(true);
    expect(isRealtimeDisabledError(new Error('Realtime is disabled.'))).toBe(true);
    expect(isRealtimeDisabledError(new Error('Realtime is disabled. '))).toBe(true);
  });

  it('does not treat other failures as disabled', () => {
    expect(isRealtimeDisabledError(new Error('Forbidden'))).toBe(false);
    expect(isRealtimeDisabledError(new Error('Too many connections.'))).toBe(false);
    expect(isRealtimeDisabledError(new Error('InternalServerError (HTTP 503)'))).toBe(false);
    expect(isRealtimeDisabledError(null)).toBe(false);
    expect(isRealtimeDisabledError('Realtime is disabled')).toBe(false);
  });

  it('starts enabled and supports reset for tests', () => {
    resetRealtimeDisabledForTesting();
    expect(isRealtimeDisabled()).toBe(false);
  });
});
