/**
 * Pure query-param parsers for the repo read-model (branches/tree/blob/
 * commits/overview granules). Extracted from `RepoRoutes` (god-file guard):
 * validation at the edge so malformed callers fail fast without burning DO
 * I/O. No Hono/D1 imports — unit-testable in isolation.
 *
 * Why strict: `ref` flows into git ref resolution and `path` into DO
 * filesystem reads. Traversal (`..`), absolute paths, backslashes, and
 * control chars must never reach the DO — return `undefined` so callers fall
 * back to the default ref/root instead of a traversal.
 */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x7f || code <= 0x1f) return true;
  }
  return false;
}

function sanitizeRefParam(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim().slice(0, 256);
  if (!trimmed) return undefined;
  // Reject git-dangerous refs: traversal, empty segments, control chars,
  // trailing lock/dot/slash, `@{` reflog syntax, and whitespace.
  if (trimmed.includes('..') || trimmed.includes('//') || trimmed.includes('\0')) return undefined;
  if (hasControlChars(trimmed) || /[\s~^:?*[\]@{\\]/.test(trimmed)) return undefined;
  if (trimmed.endsWith('.') || trimmed.endsWith('/') || trimmed.endsWith('.lock')) return undefined;
  if (trimmed.startsWith('/') || trimmed.startsWith('.')) return undefined;
  if (trimmed.split('/').some((seg) => seg.length === 0 || seg === '.' || seg === '..' || seg === '@')) return undefined;
  return trimmed;
}

function sanitizePathParam(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim().slice(0, 512);
  if (!trimmed) return undefined;
  // Reject filesystem traversal: absolute paths, `..` segments, backslashes,
  // null bytes, and control chars. Normalized paths are always relative.
  if (trimmed.includes('\0') || trimmed.includes('\\') || hasControlChars(trimmed)) return undefined;
  if (trimmed.startsWith('/')) return undefined;
  const segments = trimmed.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) return undefined;
  if (trimmed.includes('//')) return undefined;
  return trimmed;
}

function sanitizeDepthParam(raw: string | null | undefined): number | undefined {
  if (raw == null) return undefined;
  const text = raw.trim().slice(0, 16);
  if (text === '') return undefined;
  const n = Number(text);
  // Capped at 50: deeper log walks cost one tree-diff per commit in the DO
  // (each burns DO SQLite rows). Callers needing more history paginate.
  if (!Number.isSafeInteger(n) || n < 1 || n > 50) return undefined;
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
