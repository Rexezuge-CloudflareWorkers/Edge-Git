import type { Hono } from 'hono';
import { getRepoStub } from '../repoStub';
import { requireVisibleRepo, toSafeErrorMessage, toServiceStatus } from './PublicViewerResolver';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { RepoService } from '@edge-git/backend-services/repo';
import { readJsonBody } from './BodyParser';

type RepoApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

type BranchResult = { ok: boolean; error?: string; status?: number } & Record<string, unknown>;

function toBranchResponse(
  result: BranchResult,
  successStatus: 200 | 201,
): { body: unknown; status: 200 | 201 | 400 | 403 | 404 | 409 | 500 } {
  if (!result.ok) {
    const status = [400, 404, 409].includes(result.status ?? 0) ? (result.status as 400 | 404 | 409) : 500;
    return { body: { error: result.error ?? 'Branch operation failed' }, status };
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
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const { malformed, body } = await readJsonBody<{ name?: string; from?: string }>(c);
    if (malformed) return c.json({ error: 'Invalid JSON body' }, 400);
    const name = (body.name ?? '').trim();
    if (!name) return c.json({ error: 'name is required' }, 400);
    try {
      const gate = await requireWriteRole(c.env, owner, repoName, email);
      if (!gate.ok) return c.json({ error: gate.status === 404 ? 'Not found' : 'Forbidden' }, gate.status);
      const fullName = `${owner}/${repoName}`;
      const result = (await getRepoStub(c.env, fullName).createBranch({ name, fromRef: body.from || undefined })) as BranchResult;
      const { body: out, status } = toBranchResponse(result, 201);
      return c.json(out, status);
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed to create branch') }, toServiceStatus(error));
    }
  });

  app.delete('/user/repos/:owner/:repo/branches', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const branch = (new URL(c.req.url).searchParams.get('branch') ?? '').trim();
    if (!branch) return c.json({ error: 'branch query param is required' }, 400);
    try {
      const gate = await requireWriteRole(c.env, owner, repoName, email);
      if (!gate.ok) return c.json({ error: gate.status === 404 ? 'Not found' : 'Forbidden' }, gate.status);
      // Branch protection applies to everyone including admins: delete the
      // rule first, then the branch.
      const scope = createRequestScope(c.env);
      const row = await scope.get(Tokens.RepoService).getByOwnerAndName(owner, repoName);
      if (row) {
        const rule = await scope
          .get(Tokens.BranchProtectionService)
          .matchForRepo(row.id, branch)
          .catch(() => null);
        if (rule?.blockDeletion) return c.json({ error: `branch "${branch}" is protected against deletion` }, 403);
      }
      const fullName = `${owner}/${repoName}`;
      const result = (await getRepoStub(c.env, fullName).deleteBranchRef(branch)) as BranchResult;
      const { body: out, status } = toBranchResponse(result, 200);
      return c.json(out, status);
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed to delete branch') }, toServiceStatus(error));
    }
  });

  app.patch('/user/repos/:owner/:repo/branches/default', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const { malformed, body } = await readJsonBody<{ branch?: string }>(c);
    if (malformed) return c.json({ error: 'Invalid JSON body' }, 400);
    const branch = (body.branch ?? '').trim();
    if (!branch) return c.json({ error: 'branch is required' }, 400);
    try {
      const row = await requireVisibleRepo(c.env, owner, repoName, email);
      if (!row) return c.json({ error: 'Not found' }, 404);
      try {
        await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'admin');
      } catch {
        return c.json({ error: 'Forbidden' }, 403);
      }
      const fullName = `${owner}/${repoName}`;
      const result = (await getRepoStub(c.env, fullName).setDefaultBranch(branch)) as BranchResult;
      const { body: out, status } = toBranchResponse(result, 200);
      return c.json(out, status);
    } catch (error) {
      return c.json({ error: toSafeErrorMessage(error, 'Failed to update default branch') }, toServiceStatus(error));
    }
  });
}

export { registerBranchRoutes };
