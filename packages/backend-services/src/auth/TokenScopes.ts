import { BadRequestError } from '@edge-git/backend-errors';
import type { TokenScope } from '@edge-git/shared';

const TOKEN_SCOPES: readonly TokenScope[] = ['repo:read', 'repo:write', 'admin'];

const DEFAULT_TOKEN_SCOPES: readonly TokenScope[] = ['repo:read', 'repo:write', 'admin'];

// Scope hierarchy: `admin` implies `repo:write`, which implies `repo:read`.
// A token covers a requirement when it holds the required scope or any
// scope above it.
function coversScope(held: readonly TokenScope[], required: TokenScope): boolean {
  if (held.includes(required)) return true;
  if (required === 'repo:read') return held.includes('repo:write') || held.includes('admin');
  if (required === 'repo:write') return held.includes('admin');
  return false;
}

// Parse stored scopes (JSON array). NULL/legacy rows, invalid JSON, and
// empty arrays all mean full access for backward compatibility.
function parseTokenScopes(raw: unknown): TokenScope[] {
  if (raw === null || raw === undefined) return [...DEFAULT_TOKEN_SCOPES];
  try {
    const parsed: unknown = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
    if (!Array.isArray(parsed)) return [...DEFAULT_TOKEN_SCOPES];
    const valid = parsed.filter((s): s is TokenScope => typeof s === 'string' && (TOKEN_SCOPES as readonly string[]).includes(s));
    if (valid.length === 0) return [...DEFAULT_TOKEN_SCOPES];
    // Deduplicate while preserving canonical order.
    return TOKEN_SCOPES.filter((s) => valid.includes(s));
  } catch {
    return [...DEFAULT_TOKEN_SCOPES];
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
