/**
 * Pure query-param parsers for the repo read-model (branches/tree/blob/
 * commits/overview granules). Extracted from `RepoRoutes` (god-file guard):
 * validation at the edge so malformed callers fail fast without burning DO
 * I/O. No Hono/D1 imports — unit-testable in isolation.
 */
function sanitizeRefParam(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim().slice(0, 256);
  return trimmed || undefined;
}

function sanitizePathParam(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim().slice(0, 512);
  return trimmed || undefined;
}

function sanitizeDepthParam(raw: string | null | undefined): number | undefined {
  if (raw == null) return undefined;
  const text = raw.trim().slice(0, 16);
  if (text === '') return undefined;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1 || n > 500) return undefined;
  return n;
}

function parseWithLastCommit(raw: string | null): boolean | undefined {
  return parseOptionalFlag(raw);
}

function parseOptionalFlag(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  const v = raw.trim().toLowerCase();
  if (['0', 'false', 'no'].includes(v)) return false;
  if (['1', 'true', 'yes'].includes(v)) return true;
  return undefined;
}

function parseOverviewArgs(params: URLSearchParams): {
  ref?: string;
  path?: string;
  depth?: number;
  includeTags?: boolean;
  includeReadme?: boolean;
} {
  const ref = sanitizeRefParam(params.get('ref'));
  const path = sanitizePathParam(params.get('path'));
  const depth = sanitizeDepthParam(params.get('depth'));
  return {
    ref,
    path,
    depth,
    includeTags: parseOptionalFlag(params.get('includeTags')),
    includeReadme: parseOptionalFlag(params.get('includeReadme')),
  };
}

export { sanitizeRefParam, sanitizePathParam, sanitizeDepthParam, parseWithLastCommit, parseOptionalFlag, parseOverviewArgs };
