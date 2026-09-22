import { getRepoStub } from '../doStubs';
import { requireVisibleRepo, toErrorBody, toErrorType, toSafeErrorMessage, toServiceStatus } from './PublicViewerResolver';
import { recordAndNotify } from './SocialEmit';
import { presentSingle } from './IdentityPresenter';
import { triggerRequiredChecks } from './TriggerChecks';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import type { RepositoryRow } from '@edge-git/backend-data/dao';
import { getCrossRepoPreview, isPackLimitError } from './CrossFork';
import type { MergePreviewShape } from './PullShared';
import { resolveCodeownerEmails, suggestCodeownerHandles } from './CodeownerHelpers';

export interface OpenCrossForkInput {
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

// Cross-fork PR creation orchestration (DO preview + D1 create +
// CODEOWNERS auto-request + activity + CI trigger). Extracted from
// `PullMergeRoutes` (god-file guard); returns `{status, body}` with the AWS
// `{Exception:{Type,Message}}` error shape so the route stays thin HTTP wiring.
export async function openCrossForkPull(
  env: Env,
  input: OpenCrossForkInput,
): Promise<{ status: 201 | 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500; body: unknown }> {
  const headRow = await requireVisibleRepo(env, input.headOwner, input.headRepo, input.email);
  if (!headRow) return { status: 404, body: toErrorBody(404, 'Not found') };
  const headFullName = `${headRow.owner}/${headRow.name}`;
  let preview: { preview: MergePreviewShape | null };
  try {
    preview = await getCrossRepoPreview(env, input.fullName, input.baseBranch, headFullName, input.headBranch);
  } catch (error) {
    if (isPackLimitError(error))
      return { status: 413, body: toErrorBody(413, error instanceof Error ? error.message : 'Repository too large') };
    return { status: 400, body: toErrorBody(400, 'base or head branch not found') };
  }
  if (!preview.preview?.baseOid || !preview.preview?.headOid)
    return { status: 400, body: toErrorBody(400, 'base or head branch not found') };
  try {
    const scope = createRequestScope(env);
    const created = await scope.get(Tokens.PullRequestService).createPull({
      repositoryId: input.rowId,
      fullName: input.fullName,
      title: input.title,
      body: input.body,
      baseBranch: input.baseBranch,
      baseOid: preview.preview.baseOid,
      headBranch: input.headBranch,
      headOid: preview.preview.headOid,
      mergeBaseOid: preview.preview.mergeBase ?? null,
      creatorEmail: input.email,
      headRepositoryId: headRow.id,
      headFullName,
    });
    // CODEOWNERS auto-request: best-effort, never fails PR creation.
    try {
      const suggested = await suggestCodeownerHandles(env, input.fullName, {
        baseBranch: input.baseBranch,
        baseOid: preview.preview.baseOid,
        headOid: preview.preview.headOid,
      });
      const ownerEmails = await resolveCodeownerEmails(env, suggested.owners, input.email);
      if (ownerEmails.length > 0) {
        await scope.get(Tokens.CollaborationService).requestReviewers(created.id, ownerEmails);
      }
    } catch {
      // best-effort codeowner auto-request
    }
    await recordAndNotify(env, {
      repositoryId: input.rowId,
      fullName: input.fullName,
      actorEmail: input.email,
      type: 'pr_opened',
      title: `Pull request #${created.number} ${input.title}`,
      subjectType: 'pull',
      subjectNumber: created.number,
      subjectOid: preview.preview.headOid,
      mentionText: `${input.title}\n${input.body ?? ''}`,
    });
    // CI: queue required checks for the base branch against the head SHA.
    await triggerRequiredChecks(env, {
      repositoryId: input.rowId,
      fullName: input.fullName,
      branch: input.baseBranch,
      headSha: preview.preview.headOid,
      actorEmail: input.email,
    }).catch(() => undefined);
    return { status: 201, body: created };
  } catch (error) {
    const createStatus = toServiceStatus(error);
    return { status: createStatus, body: toErrorBody(createStatus, toSafeErrorMessage(error, 'Failed to create pull request')) };
  }
}

export interface MergeCrossForkInput {
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
  strategy: 'merge' | 'squash' | 'rebase';
}

// Cross-fork PR merge orchestration (head-role gate + cross-DO preview +
// DO merge + D1 record + fan-out). Moved from `PullMergeRoutes` (god-file
// guard) so the route stays thin HTTP wiring. The recorded pull is passed
// through `presentSingle` exactly like the same-repo merge path — raw
// `*_email` fields must never leak to API clients.
export async function mergeCrossForkPull(
  env: Env,
  input: MergeCrossForkInput,
): Promise<{ status: 200 | 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500; body: unknown }> {
  const permission = input.scope.get(Tokens.PermissionService);
  const headRole = await permission.getRole(input.email, input.headRow).catch(() => null);
  if (!headRole) return { status: 404, body: toErrorBody(404, 'Not found') };
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
    if (isPackLimitError(error))
      return { status: 413, body: toErrorBody(413, error instanceof Error ? error.message : 'Repository too large') };
    return { status: 400, body: toErrorBody(400, 'head branch not found') };
  }
  if (!cross.preview?.baseOid || !cross.preview?.headOid) return { status: 400, body: toErrorBody(400, 'head branch not found') };
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
      strategy: input.strategy,
    })) as { type?: string; commitOid?: string; conflicts?: string[]; reason?: string; deletedHead?: boolean };
  } catch (error) {
    return {
      status: toServiceStatus(error),
      body: { Exception: { Type: toErrorType(toServiceStatus(error)), Message: toSafeErrorMessage(error, 'Merge failed') } },
    };
  }
  if (outcome.type === 'conflict') {
    return {
      status: 409,
      body: {
        Exception: { Type: 'Conflict', Message: 'merge conflicts' },
        conflicts: outcome.conflicts ?? [],
        reason: outcome.reason ?? null,
      },
    };
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
    const merged = await input.scope
      .get(Tokens.PullRequestService)
      .markMerged({ repositoryId: input.rowId, number: input.number, mergedBy: input.email, commitOid: outcome.commitOid ?? headOid });
    await recordAndNotify(env, {
      repositoryId: input.rowId,
      fullName: input.fullName,
      actorEmail: input.email,
      type: 'pr_merged',
      title: `Pull request #${input.number} merged: ${input.pull.title}`,
      subjectType: 'pull',
      subjectNumber: input.number,
      subjectOid: outcome.commitOid ?? headOid,
    });
    return { status: 200, body: { pull: await presentSingle(input.scope, merged), merge: outcome } };
  } catch (error) {
    const status = toServiceStatus(error);
    if (status === 500) return { status: 400, body: toErrorBody(400, 'Failed to record merge') };
    const failure = error instanceof Error ? error.message : 'Failed to record merge';
    if (failure.includes('unresolved change requests')) return { status: 409, body: toErrorBody(409, failure) };
    return { status, body: toErrorBody(status, toSafeErrorMessage(error, 'Failed to record merge')) };
  }
}
