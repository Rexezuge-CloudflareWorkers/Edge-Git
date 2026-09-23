import type { RepositoryRow } from '@edge-git/backend-data/dao';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import type { AccessIdentityContext } from '@edge-git/backend-services/auth';
import { RepoFullName } from '@edge-git/shared/utils';
import { RoleRank } from '@edge-git/backend-services/permission';
import { coversScope } from '@edge-git/backend-services/auth';
import { getBasicCredentials, getBearerToken } from '@edge-git/git-protocol';
import type { RequestContext } from '@/middleware';
import { asScopedContext } from '@edge-git/backend-runtime/di';
import { BaseRoute } from '../../endpoints/IBaseRoute';

function toRepoJson(r: RepositoryRow, viewerRole?: string | null): unknown {
  const base = {
    id: r.id,
    owner: r.owner,
    name: r.name,
    fullName: `${r.owner}/${r.name}`,
    ownerType: r.owner_type ?? (r.org_id ? 'org' : 'user'),
    description: r.description,
    isPrivate: r.is_private === 1,
    forkedFrom: r.forked_from_full_name ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  return viewerRole ? { ...base, viewerRole } : base;
}

// Single-scope resolution (Otter pattern). Delegates to `BaseRoute.getScope`
// so the per-request container fallback stays consistent in one place.
function getScope(c: { get(key: string): unknown; env: unknown }): ReturnType<typeof createRequestScope> {
  return BaseRoute.getScope(c);
}

async function requireVisibleRepo(
  env: Env,
  owner: string,
  repoName: string,
  viewerEmail: string | null,
  scope?: ReturnType<typeof createRequestScope>,
): Promise<RepositoryRow | null> {
  const active = scope ?? createRequestScope(env);
  const row = await active.get(Tokens.RepoService).getByOwnerAndName(owner, repoName);
  if (!row) return null;
  const role = await active.get(Tokens.PermissionService).getRole(viewerEmail, row);
  if (!role) return null;
  return row;
}

async function requireRoleForRepo(
  env: Env,
  owner: string,
  repoName: string,
  viewerEmail: string | null,
  minimum: 'read' | 'write' | 'admin',
  scope?: ReturnType<typeof createRequestScope>,
): Promise<{ row: RepositoryRow; role: 'read' | 'write' | 'admin' } | null> {
  const active = scope ?? createRequestScope(env);
  const row = await active.get(Tokens.RepoService).getByOwnerAndName(owner, repoName);
  if (!row) return null;
  const role = await active.get(Tokens.PermissionService).getRole(viewerEmail, row);
  if (!role) return null;
  if (!RoleRank.meets(role, minimum)) return null;
  return { row, role };
}

/**
 * Best-effort viewer identity for public HTML/API routes. Returns the Access
 * email when the request carries one (or DEV/DEMO mode is on), else the PAT
 * owner when a valid token is presented, else null for anonymous visitors.
 * Never throws — anonymous is a valid outcome here.
 *
 * PATs are git-scoped: only tokens covering `repo:read` resolve to an
 * identity, and fine-grained tokens with `repoGrants` are git-only (they
 * return null here so a grant for repoA can never read repoB via the public
 * read-model; use Access or an unscoped token for API reads).
 */
async function resolvePublicViewer(c: RequestContext): Promise<string | null> {
  const scope = getScope(asScopedContext(c));
  try {
    const email = await scope
      .get(Tokens.AccessAuthService)
      .getAuthenticatedUserEmail(c.req.raw, c.executionCtx as unknown as AccessIdentityContext);
    if (email) return email;
  } catch {
    // Anonymous — fall through to PAT.
  }
  const creds = getBasicCredentials(c.req.raw);
  const bearer = getBearerToken(c.req.raw);
  const pat = creds?.password || bearer || null;
  if (!pat) return null;
  try {
    const identity = await scope.get(Tokens.TokenService).authenticateWithPAT(pat);
    if (!coversScope(identity.scopes, 'repo:read')) return null;
    if (identity.repoGrants.length > 0) return null;
    return identity.email;
  } catch {
    return null;
  }
}

async function withPublicRepo(
  c: RequestContext,
  fn: (row: RepositoryRow, fullName: string, viewerEmail: string | null) => Promise<Response>,
): Promise<Response> {
  const owner = c.req.param('owner');
  const repoParam = c.req.param('repo');
  if (!owner || !repoParam) return c.json({ Exception: { Type: 'NotFound', Message: 'Repository not found.' } }, 404);
  const repoName = RepoFullName.normalizeRepo(repoParam);
  const viewerEmail = await resolvePublicViewer(c);
  const row = await requireVisibleRepo(c.env, owner, repoName, viewerEmail, getScope(asScopedContext(c)));
  if (!row) return c.json({ Exception: { Type: 'NotFound', Message: 'Repository not found.' } }, 404);
  return fn(row, `${owner}/${repoName}`, viewerEmail);
}

/**
 * Authed read-model guard — the `/user/*` counterpart of `withPublicRepo`.
 * Previously duplicated in `RepoRoutes.withVisibleRepo`; unified here so
 * public and authed read paths share visibility semantics (private hides
 * existence → 404).
 */
async function withVisibleRepo(
  c: RequestContext,
  owner: string,
  repoName: string,
  fn: (row: RepositoryRow, fullName: string) => Promise<Response>,
): Promise<Response> {
  const email = c.get('AuthenticatedUserEmailAddress') ?? null;
  const normalized = RepoFullName.normalizeRepo(repoName);
  const row = await requireVisibleRepo(c.env, owner, normalized, email, getScope(asScopedContext(c)));
  if (!row) return c.json({ Exception: { Type: 'NotFound', Message: 'Repository not found.' } }, 404);
  return fn(row, `${owner}/${normalized}`);
}

// Shared BaseRoute helpers — delegated so both stay consistent. Routes keep
// importing from here for backwards compatibility; new code must import
// `BaseRoute` directly (these delegates are deprecated and will be removed;
// they exist only to avoid touching 30+ route imports in one sweep).
function toServiceStatus(error: unknown): 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 {
  return BaseRoute.toServiceStatus(error);
}

function toErrorType(status: number): string {
  return BaseRoute.toErrorType(status);
}

function toErrorBody(status: number, message: string): { Exception: { Type: string; Message: string } } {
  return BaseRoute.toErrorBody(status, message);
}

function jsonError(c: RequestContext, message: string, status: number): Response;
function jsonError(c: RequestContext, type: string, message: string, status: number): Response;
function jsonError(c: RequestContext, typeOrMessage: string, messageOrStatus: string | number, status = 400): Response {
  if (typeof messageOrStatus === 'number') {
    return BaseRoute.jsonError(c, typeOrMessage, messageOrStatus);
  }
  return BaseRoute.jsonError(c, typeOrMessage, messageOrStatus, status);
}

// Mask internal details on 500: callers must use this instead of echoing
// `error.message` directly, otherwise D1/DO internals leak to clients.
function toSafeErrorMessage(error: unknown, fallback: string): string {
  return BaseRoute.toSafeErrorMessage(error, fallback);
}

function parseLimit(url: string, def = 100, max = 100): number {
  return BaseRoute.parseLimit(url, def, max);
}

async function readJson<T>(c: RequestContext): Promise<{ malformed: boolean; oversized: boolean; body: T }> {
  return BaseRoute.readJson<T>(c);
}

export {
  toRepoJson,
  requireVisibleRepo,
  requireRoleForRepo,
  resolvePublicViewer,
  withPublicRepo,
  withVisibleRepo,
  toServiceStatus,
  toErrorType,
  toErrorBody,
  jsonError,
  toSafeErrorMessage,
  getScope,
  parseLimit,
  readJson,
};
