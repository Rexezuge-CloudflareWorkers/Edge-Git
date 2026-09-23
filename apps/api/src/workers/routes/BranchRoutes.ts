import type { Hono } from 'hono';
import { getRepoStub } from '../doStubs';
import { jsonError, requireVisibleRepo, toErrorBody, toSafeErrorMessage, toServiceStatus, getScope } from './PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import { readJsonBody } from './BodyParser';
import { invalidateRepoCaches } from './RepoReadCache';

type RepoApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

type BranchResult = { ok: boolean; error?: string; status?: number } & Record<string, unknown>;

function toBranchResponse(
  result: BranchResult,
  successStatus: 200 | 201,
): { body: unknown; status: 200 | 201 | 400 | 403 | 404 | 409 | 500 } {
  if (!result.ok) {
    const status = [400, 404, 409].includes(result.status ?? 0) ? (result.status as 400 | 404 | 409) : 500;
    return { body: toErrorBody(status, result.error ?? 'Branch operation failed'), status };
  }
  return { body: result, status: successStatus };
}

async function requireWriteRole(
  env: Env,
  owner: string,
  repoName: string,
  email: string,
): Promise<{ ok: true } | { ok: false; status: 403 | 404 }> {
  const row = await requireVisibleRepo(env, owner, repoName, email);
  if (!row) return { ok: false, status: 404 };
  try {
    await createRequestScope(env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    return { ok: true };
  } catch {
    return { ok: false, status: 403 };
  }
}

// Authenticated branch lifecycle — `write+` to create/delete branches
// (branch names may contain slashes, so delete takes `?branch=`),
// `admin` to move the default branch.
function registerBranchRoutes(app: RepoApp): void {
  app.post('/user/repos/:owner/:repo/branches', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const { malformed, body } = await readJsonBody<{ name?: string; from?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    const name = (body.name ?? '').trim();
    if (!name) return jsonError(c, 'name is required', 400);
    try {
      const gate = await requireWriteRole(c.env, owner, repoName, email);
      if (!gate.ok) return jsonError(c, gate.status === 404 ? 'Not found' : 'Forbidden', gate.status);
      const fullName = `${owner}/${repoName}`;
      const result = (await getRepoStub(c.env, fullName).createBranch({ name, fromRef: body.from || undefined })) as BranchResult;
      const { body: out, status } = toBranchResponse(result, 201);
      if (result.ok) {
        try {
          await invalidateRepoCaches(getScope(c).get(Tokens.KvCache), fullName);
        } catch {
          // Best-effort.
        }
      }
      return c.json(out, status);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to create branch'), toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/branches', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const branch = (new URL(c.req.url).searchParams.get('branch') ?? '').trim();
    if (!branch) return jsonError(c, 'branch query param is required', 400);
    try {
      const gate = await requireWriteRole(c.env, owner, repoName, email);
      if (!gate.ok) return jsonError(c, gate.status === 404 ? 'Not found' : 'Forbidden', gate.status);
      // Branch protection applies to everyone including admins: delete the
      // rule first, then the branch.
      const scope = getScope(c);
      const row = await scope.get(Tokens.RepoService).getByOwnerAndName(owner, repoName);
      if (row) {
        const rule = await scope
          .get(Tokens.BranchProtectionService)
          .matchForRepo(row.id, branch)
          .catch(() => null);
        if (rule?.blockDeletion) return jsonError(c, `branch "${branch}" is protected against deletion`, 403);
      }
      const fullName = `${owner}/${repoName}`;
      const result = (await getRepoStub(c.env, fullName).deleteBranchRef(branch)) as BranchResult;
      const { body: out, status } = toBranchResponse(result, 200);
      if (result.ok) {
        try {
          await invalidateRepoCaches(getScope(c).get(Tokens.KvCache), fullName);
        } catch {
          // Best-effort.
        }
      }
      return c.json(out, status);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to delete branch'), toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/branches/default', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const { malformed, body } = await readJsonBody<{ branch?: string }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    const branch = (body.branch ?? '').trim();
    if (!branch) return jsonError(c, 'branch is required', 400);
    try {
      const row = await requireVisibleRepo(c.env, owner, repoName, email);
      if (!row) return jsonError(c, 'Not found', 404);
      try {
        await getScope(c).get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      } catch {
        return jsonError(c, 'Forbidden', 403);
      }
      const fullName = `${owner}/${repoName}`;
      const result = (await getRepoStub(c.env, fullName).setDefaultBranch(branch)) as BranchResult;
      const { body: out, status } = toBranchResponse(result, 200);
      if (result.ok) {
        try {
          await invalidateRepoCaches(getScope(c).get(Tokens.KvCache), fullName);
        } catch {
          // Best-effort.
        }
      }
      return c.json(out, status);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to update default branch'), toServiceStatus(error));
    }
  });
}

export { registerBranchRoutes };
