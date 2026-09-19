import { BadRequestError } from '@edge-git/backend-errors';
import type { TokenScope } from '@edge-git/shared';

const TOKEN_SCOPES: readonly TokenScope[] = ['repo:read', 'repo:write', 'admin'];

const DEFAULT_TOKEN_SCOPES: readonly TokenScope[] = ['repo:read', 'repo:write'];

// Scope hierarchy: `admin` implies `repo:write`, which implies `repo:read`.
// A token covers a requirement when it holds the required scope or any
// scope above it.
function coversScope(held: readonly TokenScope[], required: TokenScope): boolean {
  if (held.includes(required)) return true;
  if (required === 'repo:read') return held.includes('repo:write') || held.includes('admin');
  if (required === 'repo:write') return held.includes('admin');
  return false;
}

// Parse stored scopes (JSON array). Fail closed: NULL/legacy rows, invalid
// JSON, and empty arrays grant no scopes (deny all git operations).
// Previously these fell back to full access for backward compatibility;
// that fail-open is a privilege-escalation risk on corrupt/legacy rows.
// New tokens still default via `normalizeTokenScopes(undefined)`.
function parseTokenScopes(raw: unknown): TokenScope[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed: unknown = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter((s): s is TokenScope => typeof s === 'string' && (TOKEN_SCOPES as readonly string[]).includes(s));
    if (valid.length === 0) return [];
    // Deduplicate while preserving canonical order.
    return TOKEN_SCOPES.filter((s) => valid.includes(s));
  } catch {
    return [];
  }
}

function normalizeTokenScopes(input: unknown): TokenScope[] {
  if (input === undefined || input === null) return [...DEFAULT_TOKEN_SCOPES];
  if (!Array.isArray(input) || input.length === 0) {
    throw new BadRequestError(`scopes must be a non-empty subset of ${TOKEN_SCOPES.join(', ')}`);
  }
  const valid = input.filter((s): s is TokenScope => typeof s === 'string' && (TOKEN_SCOPES as readonly string[]).includes(s));
  if (valid.length !== input.length) {
    throw new BadRequestError(`scopes must be a non-empty subset of ${TOKEN_SCOPES.join(', ')}`);
  }
  return TOKEN_SCOPES.filter((s) => valid.includes(s));
}

function serializeTokenScopes(scopes: readonly TokenScope[]): string {
  return JSON.stringify([...scopes]);
}

export { TOKEN_SCOPES, DEFAULT_TOKEN_SCOPES, coversScope, parseTokenScopes, normalizeTokenScopes, serializeTokenScopes };
