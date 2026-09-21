import { jsonError, toSafeErrorMessage, toServiceStatus } from '../PublicViewerResolver';
import { requireVisibleRepo } from '../PublicViewerResolver';
import { RepoFullName } from '@edge-git/shared/utils';
import { getRepoStub } from '../../doStubs';
import { needWrite } from './CollabHelpers';
import type { CollabApp } from './CollabHelpers';
import { readJsonBody } from '../BodyParser';

function registerCollabForkSyncRoutes(app: CollabApp): void {
  // Fork sync preview + sync (fork pulls upstream changes)
  app.get('/user/repos/:owner/:repo/sync-preview', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    const upstreamOwner = c.req.query('upstreamOwner') || '';
    const upstreamRepo = c.req.query('upstreamRepo') ? RepoFullName.normalizeRepo(c.req.query('upstreamRepo') as string) : '';
    const upstreamBranch = c.req.query('upstreamBranch') || 'main';
    const branch = c.req.query('branch') || 'main';
    if (!upstreamOwner || !upstreamRepo) return jsonError(c, 'upstreamOwner and upstreamRepo are required', 400);
    const upstreamRow = await requireVisibleRepo(c.env, upstreamOwner, upstreamRepo, email);
    if (!upstreamRow) return jsonError(c, 'Not found', 404);
    try {
      const fullName = `${owner}/${repoName}`;
      const upstreamFull = `${upstreamOwner}/${upstreamRepo}`;
      const [forkOid, upstreamOid] = await Promise.all([
        getRepoStub(c.env, fullName).resolveRef(`refs/heads/${branch}`),
        getRepoStub(c.env, upstreamFull).resolveRef(`refs/heads/${upstreamBranch}`),
      ]);
      if (!forkOid || !upstreamOid) return jsonError(c, 'branch not found', 400);
      const preview = (await getRepoStub(c.env, fullName).getMergePreviewByOids({
        baseOid: forkOid,
        headOid: upstreamOid,
      })) as {
        alreadyMerged: boolean;
        canFastForward: boolean;
        mergeBase: string | null;
      } | null;
      return c.json({
        preview: {
          forkOid,
          upstreamOid,
          alreadyMerged: preview?.alreadyMerged ?? false,
          canFastForward: preview?.canFastForward ?? false,
          mergeBase: preview?.mergeBase ?? null,
        },
      });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to preview sync'), 500);
    }
  });

  app.post('/user/repos/:owner/:repo/sync', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    if (!(await needWrite(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
    const { malformed, body } = await readJsonBody<{
      upstreamOwner?: string;
      upstreamRepo?: string;
      upstreamBranch?: string;
      branch?: string;
    }>(c);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    const upstreamOwner = body.upstreamOwner?.trim() || '';
    const upstreamRepo = body.upstreamRepo ? RepoFullName.normalizeRepo(body.upstreamRepo) : '';
    if (!upstreamOwner || !upstreamRepo) return jsonError(c, 'upstreamOwner and upstreamRepo are required', 400);
    const upstreamRow = await requireVisibleRepo(c.env, upstreamOwner, upstreamRepo, email);
    if (!upstreamRow) return jsonError(c, 'Not found', 404);
    const upstreamBranch = body.upstreamBranch?.trim() || 'main';
    const branch = body.branch?.trim() || 'main';
    try {
      const fullName = `${owner}/${repoName}`;
      const upstreamFull = `${upstreamOwner}/${upstreamRepo}`;
      const upstreamOid = await getRepoStub(c.env, upstreamFull).resolveRef(`refs/heads/${upstreamBranch}`);
      if (!upstreamOid) return jsonError(c, 'upstream branch not found', 400);
      const exported = (await getRepoStub(c.env, upstreamFull).exportPack([upstreamOid])) as { pack: Uint8Array | null };
      if (exported.pack) await getRepoStub(c.env, fullName).importPack(exported.pack);
      const outcome = (await getRepoStub(c.env, fullName).mergePull({
        baseBranch: branch,
        headOid: upstreamOid,
        authorName: email.split('@', 1)[0] || email,
        authorEmail: email,
        message: `Sync ${branch} from ${upstreamFull}@${upstreamBranch}`,
      })) as { type?: string; commitOid?: string; conflicts?: string[]; reason?: string };
      if (outcome.type === 'conflict')
        return c.json(
          {
            Exception: { Type: 'Conflict', Message: 'sync conflicts' },
            conflicts: outcome.conflicts ?? [],
            reason: outcome.reason ?? null,
          },
          409,
        );
      return c.json({ sync: outcome });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Failed to sync fork'), toServiceStatus(error));
    }
  });
}

export { registerCollabForkSyncRoutes };
