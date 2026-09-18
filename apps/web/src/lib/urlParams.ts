import type { SetURLSearchParams } from 'react-router-dom';

/*
 * Router-native port of Otter's `useSyncedUrl` pattern
 * (`Otter/apps/web/src/hooks/useSyncedUrl.ts`): navigation state lives in
 * the URL query string so copy/paste restores the exact view. Unlike Otter
 * (single view, raw `history.replaceState`), Edge-Git uses react-router, so
 * writes go through `setSearchParams(..., { replace: true })` — same
 * no-history-spam behavior, kept in sync with the router.
 */

export function readParam(params: URLSearchParams, key: string, fallback = ''): string {
  return params.get(key) ?? fallback;
}

export function readParamFlag(params: URLSearchParams, key: string): boolean {
  return params.get(key) === '1';
}

// Merge `patch` into `current`, omitting empty values; no-op when unchanged.
export function writeParams(setParams: SetURLSearchParams, current: URLSearchParams, patch: Record<string, string>): void {
  const next = new URLSearchParams(current);
  for (const [k, v] of Object.entries(patch)) {
    if (v) next.set(k, v);
    else next.delete(k);
  }
  if (next.toString() !== current.toString()) {
    setParams(next, { replace: true });
  }
}

export function parseEnumParam<T extends string>(raw: string | null, valid: readonly T[], fallback: T): T {
  return raw !== null && (valid as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/*
 * Integer params (`?depth=`, `?discussion=`) share one parser: empty or
 * non-integer input falls back, so pasted URLs can never poison list state.
 */
export function readIntParam(params: URLSearchParams, key: string, fallback: number, min?: number): number {
  const raw = params.get(key);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return fallback;
  if (min !== undefined && n < min) return fallback;
  return n;
}
