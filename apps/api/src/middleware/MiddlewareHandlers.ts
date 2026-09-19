import { Context, Next } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import type { AccessIdentityContext, AuthenticatedToken } from '@edge-git/backend-services/auth';
import { coversScope } from '@edge-git/backend-services/auth';
import { RoleRank } from '@edge-git/backend-services/permission';
import { AuditService } from '@edge-git/backend-services/audit';
import type { RepositoryRow } from '@edge-git/backend-data/dao';
import { getBasicCredentials, getBearerToken } from '@edge-git/git-protocol';
import { getRequestScope, asScopedContext } from '@edge-git/backend-runtime/di';
import { UnauthorizedError, ForbiddenError, DefaultInternalServerError } from '@edge-git/backend-errors';
import { ErrorSanitizationUtil } from '@edge-git/shared/utils';
import { flushDueWebhookDeliveries } from '@/workers/routes/SocialEmit';
type RequestContext = Context<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function getScope(c: RequestContext): ReturnType<typeof createRequestScope> {
  try {
    return getRequestScope(asScopedContext(c));
  } catch {
    // Fallback preserves unit-test helpers that invoke handlers without
    // `scopeMiddleware`. Production requests always have a scope installed.
    return createRequestScope(c.env);
  }
}

function resolveScope(c: RequestContext): ReturnType<typeof createRequestScope> {
  return getScope(c);
}

async function authenticateUserIdentity(c: RequestContext): Promise<string> {
  const scope = getScope(c);
  const email = await scope
    .get(Tokens.AccessAuthService)
    .getAuthenticatedUserEmail(c.req.raw, c.executionCtx as unknown as AccessIdentityContext);
  await scope.get(Tokens.UserService).upsertUser(email);
  return email;
}

async function userAuthenticationHandler(c: RequestContext, next: Next): Promise<Response | void> {
  try {
    const userEmail = await authenticateUserIdentity(c);
    c.set('AuthenticatedUserEmailAddress', userEmail);
    await next();
  } catch (error: unknown) {
    const status = error instanceof UnauthorizedError ? 401 : error instanceof ForbiddenError ? 403 : 500;
    // Never leak DB/DO internals on 500 — callers only need a generic message.
    // Wire shape is AWS `{Exception:{Type,Message}}`; git pkt-line paths are
    // untouched (they return plain-text 401/403 via `unauthorizedGit`).
    if (status === 500) {
      console.error('userAuthentication failed:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
      return c.json(
        {
          Exception: {
            Type: DefaultInternalServerError.getErrorType(),
            Message: DefaultInternalServerError.getErrorMessage(),
          },
        },
        500,
      );
    }
    const type = error instanceof ForbiddenError ? 'Forbidden' : 'Unauthorized';
    const message = error instanceof Error ? error.message : 'Unauthorized';
    return c.json({ Exception: { Type: type, Message: message } }, status as 401);
  }
}

export interface GitAuthResult {
  userEmail: string | null;
  repo: RepositoryRow;
  role: 'admin' | 'write' | 'read';
  scopes: string[];
}

function unauthorizedGit(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Edge-Git"' },
  });
}

async function resolvePatToEmail(c: RequestContext, pat: string): Promise<AuthenticatedToken> {
  return getScope(c).get(Tokens.TokenService).authenticateWithPAT(pat);
}

// Deploy keys are per-repo git-only credentials. A valid key scoped to this
// repo authenticates without a user identity (userEmail stays null, so push
// activity attribution is skipped but the git operation proceeds).
async function resolveDeployKey(
  c: RequestContext,
  key: string,
  repoId: string,
  service: 'git-upload-pack' | 'git-receive-pack',
): Promise<'admin' | 'write' | 'read' | null> {
  const scope = getScope(c);
  const found = await scope.get(Tokens.DeployKeyService).authenticateWithKey(key);
  if (!found || found.repositoryId !== repoId) return null;
  if (service === 'git-receive-pack' && found.permission !== 'write') return null;
  return found.permission;
}

async function gitAuthForRepo(
  c: RequestContext,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
): Promise<GitAuthResult | Response> {
  const scope = getScope(c);
  const repo = await scope.get(Tokens.RepoService).getByOwnerAndName(owner, repoName);
  if (!repo) {
    // Return 401 (not 404) to avoid repo existence oracle for private repos.
    // Callers for public UI routes should handle 404 separately.
    return unauthorizedGit();
  }
  const permission = scope.get(Tokens.PermissionService);
  const minimum = service === 'git-upload-pack' ? 'read' : 'write';

  const creds = getBasicCredentials(c.req.raw);
  const bearer = getBearerToken(c.req.raw);
  let pat: string | null = null;
  if (creds && creds.password) {
    pat = creds.password;
  } else if (bearer) {
    pat = bearer;
  }

  if (!pat) {
    // Anonymous: allowed only for public fetch/clone (read).
    const role = await permission.getRole(null, repo);
    if (role && service === 'git-upload-pack') {
      return { userEmail: null, repo, role, scopes: [] };
    }
    return unauthorizedGit();
  }

  let identity: AuthenticatedToken | null = null;
  try {
    identity = await resolvePatToEmail(c, pat);
  } catch {
    identity = null;
  }
  if (!identity) {
    // Fall back to per-repo deploy keys (same 401 either way — the key
    // itself is the secret, so no existence oracle is created).
    const keyRole = await resolveDeployKey(c, pat, repo.id, service);
    if (!keyRole) return unauthorizedGit();
    return { userEmail: null, repo, role: keyRole, scopes: ['deploy-key'] };
  }
  {
    const userEmail = identity.email;
    // PATs are git-scoped: fetch needs repo:read, push needs repo:write.
    // Insufficient scope is 403 (the token authenticated, so unlike the
    // no-role case there is no existence oracle to protect).
    const requiredScope = service === 'git-upload-pack' ? 'repo:read' : 'repo:write';
    if (!coversScope(identity.scopes, requiredScope)) {
      return new Response('Forbidden', { status: 403 });
    }
    // Fine-grained tokens: a non-empty grant set restricts the token to
    // the listed repos. No grant for this repo hides existence (401);
    // an insufficient grant scope is 403.
    if (identity.repoGrants.length > 0) {
      const grant = identity.repoGrants.find((g) => g.repositoryId === repo.id);
      if (!grant) return unauthorizedGit();
      if (!coversScope([grant.scope], requiredScope)) {
        return new Response('Forbidden', { status: 403 });
      }
    }
    const role = await permission.getRole(userEmail, repo);
    if (!role) return unauthorizedGit();
    if (!RoleRank.meets(role, minimum)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      c.set('AuthenticatedUserEmailAddress', userEmail);
    } catch {
      // context may not carry the variable on raw git routes — best-effort
    }
    return { userEmail, repo, role, scopes: identity.scopes };
  }
}

async function webhookFlushHandler(c: RequestContext, next: Next): Promise<Response | void> {
  await next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return;
  try {
    const waitUntil = (c.executionCtx as ExecutionContext | undefined)?.waitUntil?.bind(c.executionCtx);
    if (typeof waitUntil === 'function') {
      waitUntil(flushDueWebhookDeliveries(c.env).catch(() => undefined));
    }
  } catch {
    // Flush is best-effort; cron covers the gap.
  }
}

// Audit-everything (AccessBridge activityAudit pattern): records every
// request on the mounted prefixes — including reads and the audit readers
// themselves — via `waitUntil`, never failing the request. Must be
// registered BEFORE authentication middleware so denied requests are also
// captured (`AuthenticatedUserEmailAddress` is read in `finally`, after
// downstream auth has run; missing → `unknown`).
async function activityAuditHandler(c: RequestContext, next: Next): Promise<Response | void> {
  let status = 500;
  try {
    await next();
    try {
      status = c.res.status;
    } catch {
      status = 200;
    }
  } catch (error: unknown) {
    throw error;
  } finally {
    try {
      let email = 'unknown';
      try {
        email = c.get('AuthenticatedUserEmailAddress') ?? 'unknown';
      } catch {
        email = 'unknown';
      }
      const event = AuditService.buildRequestEvent(c.req.raw, email, status);
      // Reuse the per-request scope so audit uses the same memoized
      // singletons (no second Secrets Store round-trip).
      const scope = resolveScope(c);
      const record = scope.get(Tokens.AuditService).record(event).catch(() => undefined);
      const waitUntil = (c.executionCtx as ExecutionContext | undefined)?.waitUntil?.bind(c.executionCtx);
      if (typeof waitUntil === 'function') {
        waitUntil(record);
      } else {
        // No execution context (unit tests): fire-and-forget, never throws.
        void record;
      }
    } catch {
      // Auditing must never fail the request.
    }
  }
}

class MiddlewareHandlers {
  public static userAuthentication(): (c: RequestContext, next: Next) => Promise<Response | void> {
    return userAuthenticationHandler;
  }

  // Immediate webhook dispatch for mutating requests: any handler that
  // enqueued deliveries (issues, PRs, pushes, stars…) gets them POSTed via
  // `waitUntil` right after the response, without adding latency. The cron
  // sweeper retries whatever fails. Reads never trigger a flush.
  public static webhookFlush(): (c: RequestContext, next: Next) => Promise<Response | void> {
    return webhookFlushHandler;
  }

  public static activityAudit(): (c: RequestContext, next: Next) => Promise<Response | void> {
    return activityAuditHandler;
  }

  public static async requireUser(c: RequestContext): Promise<string | Response> {
    try {
      const existing = c.get('AuthenticatedUserEmailAddress') as string | undefined;
      if (existing) return existing;
      const email = await authenticateUserIdentity(c);
      c.set('AuthenticatedUserEmailAddress', email);
      return email;
    } catch (error: unknown) {
      if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
        const message = error instanceof Error ? error.message : 'Unauthorized';
        const type = error instanceof ForbiddenError ? 'Forbidden' : 'Unauthorized';
        const status = error instanceof ForbiddenError ? 403 : 401;
        return c.json({ Exception: { Type: type, Message: message } }, status as 401);
      }
      console.error('requireUser failed:', ErrorSanitizationUtil.sanitizeErrorForLogging(error));
      return c.json(
        {
          Exception: {
            Type: DefaultInternalServerError.getErrorType(),
            Message: DefaultInternalServerError.getErrorMessage(),
          },
        },
        500,
      );
    }
  }
}

export { MiddlewareHandlers, gitAuthForRepo, unauthorizedGit };
export type { RequestContext };

export { type TokenService } from '@edge-git/backend-services/auth';
export { NotFoundError } from '@edge-git/backend-errors';
