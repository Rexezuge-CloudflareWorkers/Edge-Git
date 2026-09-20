import type { Context } from 'hono';
import { Tokens } from '@edge-git/backend-services/composition';
import type { AuthenticatedToken } from '@edge-git/backend-services/auth';
import { coversScope } from '@edge-git/backend-services/auth';
import { RoleRank } from '@edge-git/backend-services/permission';
import type { RepositoryRow } from '@edge-git/backend-data/dao';
import { getBasicCredentials, getBearerToken } from '@edge-git/git-protocol';
import { DatabaseError } from '@edge-git/backend-errors';
import { BaseRoute } from '../endpoints/IBaseRoute';

type RequestContext = Context<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

// Single-scope resolution delegates to `BaseRoute.getScope` (Otter pattern) —
// one fallback (fresh scope for helpers/tests outside middleware ordering)
// shared by `MiddlewareHandlers` and the git auth flow below.
function getScope(c: RequestContext): ReturnType<typeof BaseRoute.getScope> {
  return BaseRoute.getScope(c);
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
  try {
    return await gitAuthForRepoInner(c, owner, repoName, service);
  } catch (error: unknown) {
    // Fail closed on persistence outages anywhere in the auth read path
    // (repo lookup, PAT/deploy-key verification, role resolution): 503 keeps
    // an outage distinguishable from bad credentials (401) for clients and
    // avoids Hono's generic 500 masking. Auth-level failures never throw —
    // they return 401/403 from the inner flow.
    if (error instanceof DatabaseError) {
      return new Response('Authentication unavailable', { status: 503 });
    }
    throw error;
  }
}

async function gitAuthForRepoInner(
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
  } catch (error: unknown) {
    // Fail closed on persistence outages: a D1 failure during PAT lookup
    // rethrows to the outer wrapper (→ 503), not degrades to 401 where it
    // would be indistinguishable from a bad token. Auth-level failures
    // (unknown/expired token) still fall through to the deploy-key check.
    if (error instanceof DatabaseError) throw error;
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
export { gitAuthForRepo, unauthorizedGit, getScope };
export type { RequestContext };
