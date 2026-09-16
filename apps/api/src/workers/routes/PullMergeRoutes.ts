import { getRepoStub } from '../repoStub';
import { requireVisibleRepo, toServiceStatus } from './PublicViewerResolver';
import type { RepositoryRow } from '@edge-git/backend-data/dao';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { PullRequestService } from '@edge-git/backend-services/pull';
import { BranchProtectionService } from '@edge-git/backend-services/protection';
import { RepoService } from '@edge-git/backend-services/repo';
import { getCrossRepoPreview, isPackLimitError, resolveHeadRepo } from './CrossFork';
import { parsePullNumber } from './PullShared';
import type { MergePreviewShape, PullApp } from './PullShared';

interface OpenCrossForkInput {
  email: string;
  rowId: string;
  fullName: string;
  baseBranch: string;
  headBranch: string;
  headOwner: string;
  headRepo: string;
  title: string;
  body: string | null;
}

async function openCrossForkPull(env: Env, input: OpenCrossForkInput): Promise<{ status: 201 | 400 | 403 | 404 | 413 | 500; body: unknown }> {
  const headRow = await requireVisibleRepo(env, input.headOwner, input.headRepo, input.email);
  if (!headRow) return { status: 404, body: { error: 'Not found' } };
  const headFullName = `${headRow.owner}/${headRow.name}`;
  let preview: { preview: MergePreviewShape | null };
  try {
    preview = await getCrossRepoPreview(env, input.fullName, input.baseBranch, headFullName, input.headBranch);
  } catch (error) {
    if (isPackLimitError(error)) return { status: 413, body: { error: error instanceof Error ? error.message : 'Repository too large' } };
    return { status: 400, body: { error: 'base or head branch not found' } };
  }
  if (!preview.preview?.baseOid || !preview.preview?.headOid) return { status: 400, body: { error: 'base or head branch not found' } };
  try {
    const created = await createRequestScope(env)
      .get(Tokens.PullRequestService)
      .createPull({
        repositoryId: input.rowId,
        fullName: input.fullName,
        title: input.title,
        body: input.body,
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        baseOid: preview.preview.baseOid,
        headOid: preview.preview.headOid,
        mergeBaseOid: preview.preview.mergeBase ?? null,
        creatorEmail: input.email,
        headRepositoryId: headRow.id,
        headFullName,
      });
    return { status: 201, body: created };
  } catch (error) {
    return { status: toServiceStatus(error), body: { error: error instanceof Error ? error.message : 'Failed to create pull request' } };
  }
}

interface MergeCrossForkInput {
  email: string;
  scope: ReturnType<typeof createRequestScope>;
  rowId: string;
  number: number;
  pull: { title: string; base_branch: string; head_branch: string };
  fullName: string;
  headFullName: string;
  headRow: RepositoryRow;
  message: string;
  deleteHead: boolean;
}

async function mergeCrossForkPull(env: Env, input: MergeCrossForkInput): Promise<{ status: 200 | 400 | 403 | 404 | 409 | 413 | 500; body: unknown }> {
  const permission = input.scope.get(Tokens.PermissionService);
  const headRole = await permission.getRole(input.email, input.headRow).catch(() => null);
  if (!headRole) return { status: 404, body: { error: 'Not found' } };
  // Head-branch deletion is best-effort: without write on the fork the merge
  // still proceeds and reports deletedHead: false.
  let canDeleteHead = false;
  if (input.deleteHead) {
    try {
      await input.scope.get(Tokens.RepoService).requireRole(input.headRow.owner, input.headRow.name, input.email, 'write');
      canDeleteHead = true;
    } catch {
      canDeleteHead = false;
    }
  }
  let cross: { preview: MergePreviewShape | null };
  try {
    cross = await getCrossRepoPreview(env, input.fullName, input.pull.base_branch, input.headFullName, input.pull.head_branch);
  } catch (error) {
    if (isPackLimitError(error)) return { status: 413, body: { error: error instanceof Error ? error.message : 'Repository too large' } };
    return { status: 400, body: { error: 'head branch not found' } };
  }
  if (!cross.preview?.baseOid || !cross.preview?.headOid) return { status: 400, body: { error: 'head branch not found' } };
  const headOid = cross.preview.headOid;
  try {
    await input.scope.get(Tokens.PullRequestService).refreshOids({
      repositoryId: input.rowId,
      number: input.number,
      baseOid: cross.preview.baseOid,
      headOid: cross.preview.headOid,
      mergeBaseOid: cross.preview.mergeBase ?? null,
    });
  } catch {
    // Best-effort: stale stored oids must not block the merge itself.
  }
  let outcome: { type?: string; commitOid?: string; conflicts?: string[]; reason?: string; deletedHead?: boolean };
  try {
    outcome = (await getRepoStub(env, input.fullName).mergePull({
      baseBranch: input.pull.base_branch,
      headOid,
      authorName: input.email.split('@', 1)[0] || input.email,
      authorEmail: input.email,
      message: input.message,
    })) as { type?: string; commitOid?: string; conflicts?: string[]; reason?: string; deletedHead?: boolean };
  } catch (error) {
    return { status: 500, body: { error: error instanceof Error ? error.message : 'Merge failed' } };
  }
  if (outcome.type === 'conflict') {
    return { status: 409, body: { error: 'merge conflicts', conflicts: outcome.conflicts ?? [], reason: outcome.reason ?? null } };
  }
  if (canDeleteHead && input.deleteHead) {
    try {
      const deleted = (await getRepoStub(env, input.headFullName).deleteBranch(input.pull.head_branch)) as { deleted?: boolean };
      outcome = { ...outcome, deletedHead: deleted.deleted === true };
    } catch {
      outcome = { ...outcome, deletedHead: false };
    }
  } else if (input.deleteHead) {
    outcome = { ...outcome, deletedHead: false };
  }
  try {
    const merged = await input.scope.get(Tokens.PullRequestService).markMerged({ repositoryId: input.rowId, number: input.number, mergedBy: input.email, commitOid: outcome.commitOid ?? headOid });
    return { status: 200, body: { pull: merged, merge: outcome } };
  } catch (error) {
    const failure = error instanceof Error ? error.message : 'Failed to record merge';
    const status = failure.includes('unresolved change requests') ? 409 : toServiceStatus(error);
    return { status: status === 500 ? 400 : status, body: { error: failure } };
  }
}

function registerUserPullMergeRoutes(app: PullApp): void {
  // Merge: write+ only. changes_requested reviews block the merge (409).
  // Conflicts from the DO also surface as 409 with the file list.
  // Cross-fork PRs materialize head objects into the base DO before merging;
  // deleteHead then targets the head repo DO (best-effort, needs head write).
  app.post('/user/repos/:owner/:repo/pulls/:number/merge', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoService.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return c.json({ error: 'Not found' }, 404);
    try {
      await createRequestScope(c.env).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return c.json({ error: 'Not found' }, 404);
    const scope = createRequestScope(c.env);
    let pull;
    try {
      pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Not found' }, toServiceStatus(error));
    }
    if (pull.status === 'merged') return c.json({ error: 'pull request is already merged' }, 400);
    if (pull.status === 'closed') return c.json({ error: 'closed pull requests cannot be merged' }, 400);
    // Fail fast on blocking reviews before touching git.
    const reviews = await scope.get(Tokens.PullRequestService).listReviews(row.id, number);
    if (PullRequestService.isBlockedByReviews(reviews)) return c.json({ error: 'pull request has unresolved change requests' }, 409);
    // Branch protection: the base branch may require N approvals (excluding
    // the PR creator). Applies to same-repo and cross-fork merges alike.
    // Missing protection table on legacy DBs means no rule (fall through).
    const rule = await scope.get(Tokens.BranchProtectionService).matchForRepo(row.id, pull.base_branch).catch(() => null);
    const gate = BranchProtectionService.checkMergeBlocked({ rule, reviews, creatorEmail: pull.creator_email });
    if (gate.blocked) return c.json({ error: gate.reason ?? 'pull request is blocked by branch protection' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { message?: string; deleteHead?: boolean };
    const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
    const message = rawMessage ? rawMessage.slice(0, 1000) : `Merge pull request #${number}: ${pull.title}`;
    const deleteHead = body.deleteHead === true;
    const fullName = `${owner}/${repoName}`;
    const head = await resolveHeadRepo(c.env, pull);
    if (head) {
      const result = await mergeCrossForkPull(c.env, { email, scope, rowId: row.id, number, pull, fullName, headFullName: head.fullName, headRow: head.row, message, deleteHead });
      return c.json(result.body, result.status);
    }
    // Refresh oids from git truth (branches may have moved since PR creation).
    let headOid = pull.head_oid;
    try {
      const preview = (await getRepoStub(c.env, fullName).getMergePreview({
        baseRef: `refs/heads/${pull.base_branch}`,
        headRef: `refs/heads/${pull.head_branch}`,
      })) as MergePreviewShape | null;
      if (preview?.headOid) headOid = preview.headOid;
      if (preview && (preview.baseOid || preview.headOid)) {
        try {
          await scope.get(Tokens.PullRequestService).refreshOids({
            repositoryId: row.id,
            number,
            baseOid: preview.baseOid ?? null,
            headOid: preview.headOid ?? null,
            mergeBaseOid: preview.mergeBase ?? null,
          });
        } catch {
          // Best-effort: stale stored oids must not block the merge itself.
        }
      }
    } catch {
      // fall through with stored oid
    }
    if (!headOid) return c.json({ error: 'head branch not found' }, 400);
    let outcome: { type?: string; commitOid?: string; conflicts?: string[]; reason?: string; deletedHead?: boolean };
    try {
      outcome = (await getRepoStub(c.env, `${owner}/${repoName}`).mergePull({
        baseBranch: pull.base_branch,
        headBranch: pull.head_branch,
        headOid,
        authorName: email.split('@', 1)[0] || email,
        authorEmail: email,
        message,
        deleteHead,
      })) as { type?: string; commitOid?: string; conflicts?: string[]; reason?: string; deletedHead?: boolean };
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Merge failed' }, 500);
    }
    if (outcome.type === 'conflict') {
      return c.json({ error: 'merge conflicts', conflicts: outcome.conflicts ?? [], reason: outcome.reason ?? null }, 409);
    }
    try {
      const merged = await scope.get(Tokens.PullRequestService).markMerged({ repositoryId: row.id, number, mergedBy: email, commitOid: outcome.commitOid ?? headOid });
      return c.json({ pull: merged, merge: outcome });
    } catch (error) {
      const failure = error instanceof Error ? error.message : 'Failed to record merge';
      const status = failure.includes('unresolved change requests') ? 409 : toServiceStatus(error);
      return c.json({ error: failure }, status === 500 ? 400 : status);
    }
  });
}

export { openCrossForkPull, registerUserPullMergeRoutes };
export type { OpenCrossForkInput };
