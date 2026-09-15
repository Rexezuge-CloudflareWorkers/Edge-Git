import type { RepositoryRow } from '@edge-git/backend-data/dao';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import type { AccessIdentityContext } from '@edge-git/backend-services/auth';
import { RepoService } from '@edge-git/backend-services/repo';
import { ServiceError } from '@edge-git/backend-errors';
import { getBasicCredentials, getBearerToken } from '@edge-git/git-protocol';
import type { RequestContext } from '@/middleware';

function toRepoJson(r: RepositoryRow): unknown {
  return {
    id: r.id,
    owner: r.owner,
    name: r.name,
    fullName: `${r.owner}/${r.name}`,
    description: r.description,
    isPrivate: r.is_private === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function requireVisibleRepo(env: Env, owner: string, repoName: string, viewerEmail: string | null): Promise<RepositoryRow | null> {
  const row = await createRequestScope(env).get(Tokens.RepoService).getByOwnerAndName(owner, repoName);
  if (!row) return null;
  if (row.is_private === 1 && row.owner_email !== viewerEmail) return null;
  return row;
}

/**
 * Best-effort viewer identity for public HTML/API routes. Returns the Access
 * email when the request carries one (or DEV/DEMO mode is on), else the PAT
 * owner when a valid token is presented, else null for anonymous visitors.
 * Never throws — anonymous is a valid outcome here.
 */
async function resolvePublicViewer(c: RequestContext): Promise<string | null> {
  const scope = createRequestScope(c.env);
  try {
    const email = await scope.get(Tokens.AccessAuthService).getAuthenticatedUserEmail(
      c.req.raw,
      c.executionCtx as unknown as AccessIdentityContext,
    );
    if (email) return email;
  } catch {
    // Anonymous — fall through to PAT.
  }
  const creds = getBasicCredentials(c.req.raw);
  const bearer = getBearerToken(c.req.raw);
  const pat = creds?.password || bearer || null;
  if (!pat) return null;
  try {
    return await scope.get(Tokens.TokenService).authenticateWithPAT(pat);
  } catch {
    return null;
  }
}

async function withPublicRepo(c: RequestContext, fn: (row: RepositoryRow, fullName: string) => Promise<Response>): Promise<Response> {
  const owner = c.req.param('owner');
  const repoParam = c.req.param('repo');
  if (!owner || !repoParam) return c.json({ error: 'Not found' }, 404);
  const repoName = RepoService.normalizeRepo(repoParam);
  const viewerEmail = await resolvePublicViewer(c);
  const row = await requireVisibleRepo(c.env, owner, repoName, viewerEmail);
  if (!row) return c.json({ error: 'Not found' }, 404);
  return fn(row, `${owner}/${repoName}`);
}

function toServiceStatus(error: unknown): 400 | 403 | 404 | 500 {
  if (error instanceof ServiceError) {
    const code = error.getErrorCode();
    if (([400, 403, 404] as readonly number[]).includes(code)) {
      return code as 400 | 403 | 404;
    }
  }
  return 500;
}

export { toRepoJson, requireVisibleRepo, resolvePublicViewer, withPublicRepo, toServiceStatus };
