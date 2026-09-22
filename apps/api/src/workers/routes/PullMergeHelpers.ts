import { requireVisibleRepo, toErrorBody, toSafeErrorMessage, toServiceStatus } from './PublicViewerResolver';
import { recordAndNotify } from './SocialEmit';
import { triggerRequiredChecks } from './TriggerChecks';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
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
