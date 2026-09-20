import type { Next } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import type { AccessIdentityContext } from '@edge-git/backend-services/auth';
import { AuditService } from '@edge-git/backend-services/audit';
import { UnauthorizedError, ForbiddenError, DefaultInternalServerError } from '@edge-git/backend-errors';
import { ErrorSanitizationUtil } from '@edge-git/shared/utils';
import { flushDueWebhookDeliveries } from '@/workers/routes/SocialEmit';
import {   getScope } from './GitAuth';
import type { RequestContext } from './GitAuth';

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
      const scope = getScope(c);
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

export { MiddlewareHandlers,   };

export type { GitAuthResult, RequestContext } from './GitAuth';

export { type TokenService } from '@edge-git/backend-services/auth';
export { NotFoundError } from '@edge-git/backend-errors';

export {gitAuthForRepo, unauthorizedGit} from './GitAuth';