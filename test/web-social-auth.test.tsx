// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }),
}));

vi.mock('../apps/web/src/realtime/useRealtime', () => ({
  useRealtimeSubscription: () => ({ status: 'offline', viewers: [], typing: [], sendTyping: () => {} }),
}));

import { useSocialState } from '../apps/web/src/components/repo/SocialButtons';

function jsonResponse(payload: unknown): Response {
  return { ok: true, json: async () => payload } as Response;
}

describe('useSocialState auth upgrade', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('refetches viewerStarred/viewerWatching on null->true upgrade', async () => {
    const anonStars = { count: 1, starsCount: 1, viewerStarred: false };
    const anonWatches = { count: 2, watchersCount: 2, viewerWatching: false };
    const authedStars = { count: 1, starsCount: 1, viewerStarred: true };
    const authedWatches = { count: 3, watchersCount: 3, viewerWatching: true };

    let phase: 'anon' | 'authed' = 'anon';
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/stars')) return jsonResponse(phase === 'anon' ? anonStars : authedStars);
      if (url.includes('/watches')) return jsonResponse(phase === 'anon' ? anonWatches : authedWatches);
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(({ authorized }) => useSocialState({ owner: 'alice', repo: 'demo', authorized, showNotice: () => {} }), {
      initialProps: { authorized: null as boolean | null },
    });

    await waitFor(() => expect(result.current.starsCount).toBe(1));
    expect(result.current.starred).toBe(false);
    expect(result.current.watching).toBe(false);
    const callsAfterAnon = fetchMock.mock.calls.length;

    phase = 'authed';
    rerender({ authorized: true });

    await waitFor(() => expect(result.current.starred).toBe(true));
    expect(result.current.watching).toBe(true);
    expect(result.current.watchersCount).toBe(3);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterAnon);
  });

  it('does not refetch on null->false (both anonymous)', async () => {
    const payload = { count: 0, starsCount: 0, viewerStarred: false };
    const watchPayload = { count: 0, watchersCount: 0, viewerWatching: false };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/stars')) return jsonResponse(payload);
      return jsonResponse(watchPayload);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = renderHook(({ authorized }) => useSocialState({ owner: 'bob', repo: 'demo', authorized, showNotice: () => {} }), {
      initialProps: { authorized: null as boolean | null },
    });

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
    const calls = fetchMock.mock.calls.length;
    // Allow any pending microtasks to settle, then transition to false.
    await act(async () => {});
    rerender({ authorized: false });
    await act(async () => {});
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});
