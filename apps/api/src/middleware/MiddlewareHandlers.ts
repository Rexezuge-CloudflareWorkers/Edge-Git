import { Context, Next } from 'hono';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import type { AccessIdentityContext } from '@edge-git/backend-services/auth';
import type { RepositoryRow } from '@edge-git/backend-data/dao';
import { getBasicCredentials, getBearerToken } from '@edge-git/git-protocol';
import { UnauthorizedError, ForbiddenError } from '@edge-git/backend-errors';

type RequestContext = Context<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

async function authenticateUserIdentity(c: RequestContext): Promise<string> {
  const env = c.env;
  const scope = createRequestScope(env);
  const email = await scope.get(Tokens.AccessAuthService).getAuthenticatedUserEmail(
    c.req.raw,
    c.executionCtx as unknown as AccessIdentityContext,
  );
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
    const message = error instanceof Error ? error.message : 'Unauthorized';
    return c.json({ error: message }, status as 401);
  }
}

export interface GitAuthResult {
  userEmail: string | null;
  repo: RepositoryRow;
  role: 'admin' | 'write' | 'read';
}

function unauthorizedGit(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Edge-Git"' },
  });
}

async function resolvePatToEmail(env: Env, pat: string): Promise<string> {
  return createRequestScope(env).get(Tokens.TokenService).authenticateWithPAT(pat);
}

async function gitAuthForRepo(
  c: RequestContext,
  owner: string,
  repoName: string,
  service: 'git-upload-pack' | 'git-receive-pack',
): Promise<GitAuthResult | Response> {
  const env = c.env;
  const scope = createRequestScope(env);
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
      return { userEmail: null, repo, role };
    }
    return unauthorizedGit();
  }

  try {
    const userEmail = await resolvePatToEmail(env, pat);
    const role = await permission.getRole(userEmail, repo);
    if (!role) return unauthorizedGit();
    const rank = role === 'admin' ? 3 : role === 'write' ? 2 : 1;
    const need = minimum === 'write' ? 2 : 1;
    if (rank < need) {
      return new Response('Forbidden', { status: 403 });
    }
    return { userEmail, repo, role };
  } catch {
    return unauthorizedGit();
  }
}

class MiddlewareHandlers {
  public static userAuthentication(): (c: RequestContext, next: Next) => Promise<Response | void> {
    return userAuthenticationHandler;
  }

  public static async requireUser(c: RequestContext): Promise<string | Response> {
    try {
      const existing = c.get('AuthenticatedUserEmailAddress') as string | undefined;
      if (existing) return existing;
      const email = await authenticateUserIdentity(c);
      c.set('AuthenticatedUserEmailAddress', email);
      return email;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unauthorized';
      return c.json({ error: message }, 401);
    }
  }
}

export { MiddlewareHandlers, gitAuthForRepo, unauthorizedGit };
export type { RequestContext };

export { type TokenService } from '@edge-git/backend-services/auth';
export { NotFoundError } from '@edge-git/backend-errors';
