import { getRepoStub } from '../doStubs';
import { jsonError, requireVisibleRepo, toSafeErrorMessage, toServiceStatus, getScope } from './PublicViewerResolver';
import { recordAndNotify } from './SocialEmit';
import { Tokens } from '@edge-git/backend-services/composition';
import { presentSingle } from './IdentityPresenter';
import { CheckService } from '@edge-git/backend-services/checks';
import { PullRequestService } from '@edge-git/backend-services/pull';
import { BranchProtectionService } from '@edge-git/backend-services/protection';
import { RepoFullName } from '@edge-git/shared/utils';
import { resolveHeadRepo } from './CrossFork';
import { parsePullNumber } from './PullShared';
import type { MergePreviewShape, PullApp } from './PullShared';
import { resolveCodeownerEmails, suggestCodeownerHandles } from './CodeownerHelpers';
import { readJsonBody } from './BodyParser';
import { mergeCrossForkPull } from './PullMergeHelpers';

function registerUserPullMergeRoutes(app: PullApp): void {
  // Merge: write+ only. changes_requested reviews block the merge (409).
  // Conflicts from the DO also surface as 409 with the file list.
  // Cross-fork PRs materialize head objects into the base DO before merging;
  // deleteHead then targets the head repo DO (best-effort, needs head write).
  app.post('/user/repos/:owner/:repo/pulls/:number/merge', async (c) => {
    const email = c.get('AuthenticatedUserEmailAddress');
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, email);
    if (!row) return jsonError(c, 'Not found', 404);
    try {
      await getScope(c).get(Tokens.RepoService).requireRole(owner, repoName, email, 'write');
    } catch {
      return jsonError(c, 'Forbidden', 403);
    }
    const number = parsePullNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    const scope = getScope(c);
    let pull;
    try {
      pull = await scope.get(Tokens.PullRequestService).getByNumber(row.id, number);
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
    if (pull.status === 'merged') return jsonError(c, 'pull request is already merged', 400);
    if (pull.status === 'closed') return jsonError(c, 'closed pull requests cannot be merged', 400);
    if ((pull as { is_draft?: number | null }).is_draft === 1) return jsonError(c, 'draft pull requests cannot be merged', 409);
    // Fail fast on blocking reviews before touching git.
    const reviews = await scope.get(Tokens.PullRequestService).listReviews(row.id, number);
    if (PullRequestService.isBlockedByReviews(reviews)) return jsonError(c, 'pull request has unresolved change requests', 409);
    // Branch protection: the base branch may require N approvals (excluding
    // the PR creator). Applies to same-repo and cross-fork merges alike.
    // Missing protection table on legacy DBs means no rule (fall through).
    // CODEOWNERS enforcement is best-effort: when owners resolve for the
    // changed paths, one non-creator owner approval is required; when the
    // CODEOWNERS file or diff is unreadable there is no owner quorum.
    const rule = await scope
      .get(Tokens.BranchProtectionService)
      .matchForRepo(row.id, pull.base_branch)
      .catch(() => null);
    const fullName = `${owner}/${repoName}`;
    const codeownerEmails = await suggestCodeownerHandles(c.env, fullName, {
      baseBranch: pull.base_branch,
      baseOid: pull.base_oid ?? null,
      headOid: pull.head_oid ?? null,
    })
      .then((suggested) => resolveCodeownerEmails(c.env, suggested.owners, pull.creator_email))
      .catch(() => [] as string[]);
    const gate = BranchProtectionService.checkMergeBlocked({
      rule,
      reviews,
      creatorEmail: pull.creator_email,
      codeowners: { owners: codeownerEmails },
    });
    if (gate.blocked) return jsonError(c, gate.reason ?? 'pull request is blocked by branch protection', 409);
    // Required status checks: every context listed on the matched rule must
    // report a passing conclusion (success/neutral/skipped) on the merge head
    // SHA. Missing or pending runs block; direct pushes are unaffected
    // (merge-gate only, per v1 scope).
    const requiredContexts = rule?.requireStatusChecks ?? [];
    if (requiredContexts.length > 0) {
      const headSha = pull.head_oid ?? null;
      if (!headSha)
        return c.json(
          {
            Exception: { Type: 'Conflict', Message: 'required status checks are pending: head commit unknown' },
            requiredChecks: requiredContexts,
            state: 'pending',
          },
          409,
        );
      const runs = await scope
        .get(Tokens.CheckService)
        .listForSha(row.id, headSha)
        .then((r) => r.runs)
        .catch(() => []);
      const checkGate = CheckService.checkRequiredContexts({
        requiredContexts,
        runs: runs.map((r) => ({ context: r.context, status: r.status, conclusion: r.conclusion })),
      });
      if (checkGate.blocked) {
        const detail =
          checkGate.failing.length > 0
            ? `failing checks: ${checkGate.failing.join(', ')}`
            : `pending checks: ${checkGate.pending.join(', ')}`;
        return c.json(
          {
            Exception: { Type: 'Conflict', Message: `required status checks not satisfied (${detail})` },
            requiredChecks: requiredContexts,
            state: checkGate.state,
            pending: checkGate.pending,
            failing: checkGate.failing,
          },
          409,
        );
      }
    }
    const { malformed, oversized, body } = await readJsonBody<{ message?: string; deleteHead?: boolean; strategy?: string }>(c);
    if (oversized) return jsonError(c, 'Payload too large', 413);
    if (malformed) return jsonError(c, 'Invalid JSON body', 400);
    const rawMessage = typeof body.message === 'string' ? body.message.trim() : '';
    const message = rawMessage ? rawMessage.slice(0, 1000) : `Merge pull request #${number}: ${pull.title}`;
    const deleteHead = body.deleteHead === true;
    const strategy = body.strategy === 'squash' || body.strategy === 'rebase' ? body.strategy : 'merge';
    const head = await resolveHeadRepo(c.env, pull);
    if (head) {
      const result = await mergeCrossForkPull(c.env, {
        email,
        scope,
        rowId: row.id,
        number,
        pull,
        fullName,
        headFullName: head.fullName,
        headRow: head.row,
        message,
        deleteHead,
        strategy,
      });
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
    if (!headOid) return jsonError(c, 'head branch not found', 400);
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
        strategy,
      })) as { type?: string; commitOid?: string; conflicts?: string[]; reason?: string; deletedHead?: boolean };
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Merge failed'), toServiceStatus(error));
    }
    if (outcome.type === 'conflict') {
      return c.json(
        {
          Exception: { Type: 'Conflict', Message: 'merge conflicts' },
          conflicts: outcome.conflicts ?? [],
          reason: outcome.reason ?? null,
        },
        409,
      );
    }
    try {
      const merged = await scope
        .get(Tokens.PullRequestService)
        .markMerged({ repositoryId: row.id, number, mergedBy: email, commitOid: outcome.commitOid ?? headOid });
      await recordAndNotify(c.env, {
        repositoryId: row.id,
        fullName,
        actorEmail: email,
        type: 'pr_merged',
        title: `Pull request #${number} merged: ${pull.title}`,
        subjectType: 'pull',
        subjectNumber: number,
        subjectOid: outcome.commitOid ?? headOid,
        participantEmails: [pull.creator_email],
      });
      return c.json({ pull: await presentSingle(scope, merged), merge: outcome });
    } catch (error) {
      const status = toServiceStatus(error);
      if (status === 500) return jsonError(c, 'Failed to record merge', 400);
      const failure = error instanceof Error ? error.message : 'Failed to record merge';
      if (failure.includes('unresolved change requests')) return jsonError(c, failure, 409);
      return jsonError(c, toSafeErrorMessage(error, 'Failed to record merge'), status);
    }
  });
}

export { registerUserPullMergeRoutes };
export { mergeCrossForkPull, openCrossForkPull } from './PullMergeHelpers';
export type { MergeCrossForkInput, OpenCrossForkInput } from './PullMergeHelpers';
