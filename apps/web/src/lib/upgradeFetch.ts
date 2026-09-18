import { useRef } from 'react';

export interface UpgradeFetchState<T> {
  // Key of the last successfully loaded request.
  key: string | null;
  // Key + promise of the request currently in flight, if any.
  inflightKey: string | null;
  inflight: Promise<T> | null;
}

export function createUpgradeFetchState<T>(): UpgradeFetchState<T> {
  return { key: null, inflightKey: null, inflight: null };
}

export function useUpgradeFetchState<T>(): { current: UpgradeFetchState<T> } {
  return useRef<UpgradeFetchState<T>>(createUpgradeFetchState());
}

export type UpgradeLoad<T> = () => Promise<T>;

export type UpgradeResult<T> = { status: 'skipped' } | { status: 'loaded'; data: T };

/**
 * Single-flight read across the anonymous→signed-in upgrade.
 *
 * Public and authed read-models return identical payloads for any request
 * the public endpoint serves (same DO RPC, no viewer input — sessions even
 * leak identity into public handlers best-effort), so:
 * - a same-key request that already settled is skipped, and
 * - a same-key request still in flight is awaited instead of firing a
 *   second request for the same data.
 *
 * Keys are marked only on success, so a public 404 (private repo, no
 * session) still retries authed after the upgrade. Callers check their own
 * `cancelled` flag afterwards.
 */
export async function fetchUpgraded<T>(st: UpgradeFetchState<T>, key: string, load: UpgradeLoad<T>): Promise<UpgradeResult<T>> {
  if (st.key === key) return { status: 'skipped' };
  const shared = st.inflightKey === key ? st.inflight : null;
  if (shared) {
    try {
      const data = await shared;
      st.key = key;
      return { status: 'loaded', data };
    } catch {
      // Public load failed (e.g. private repo) — fall through to authed.
    }
  }
  const promise = load();
  st.inflightKey = key;
  st.inflight = promise;
  try {
    const data = await promise;
    st.key = key;
    return { status: 'loaded', data };
  } finally {
    if (st.inflight === promise) {
      st.inflight = null;
      st.inflightKey = null;
    }
  }
}
