/**
 * Pure route-input helpers (no Hono/D1 imports).
 *
 * Why: `decodeURIComponent` on `:member`/`:reviewer` params threw `URIError`
 * (500) on malformed escapes, and `Number(limit)` silently coerced `NaN` to a
 * default. Centralizing fail-closed parsing keeps every route consistent and
 * unit-testable without a request context.
 */

function decodeRouteParam(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function parseLimitParam(raw: string | null | undefined, fallback: number, max: number): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 1 || n > max) return fallback;
  return n;
}

function parseContentLength(header: string | null | undefined): number | null {
  if (header == null || header.trim() === '') return null;
  const n = Number(header.trim());
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

export { decodeRouteParam, parseLimitParam, parseContentLength };
