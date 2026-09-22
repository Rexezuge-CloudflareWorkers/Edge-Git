import { jsonError, toSafeErrorMessage, toServiceStatus, getScope } from '../PublicViewerResolver';
import { requireVisibleRepo } from '../PublicViewerResolver';
import { Tokens } from '@edge-git/backend-services/composition';
import { RepoFullName } from '@edge-git/shared/utils';
import { getIssueMetaSafe, needWrite, parseNumber } from './CollabHelpers';
import type { CollabApp } from './CollabHelpers';
import { readJsonBody } from '../BodyParser';
import { presentSingle, usernameFor, usernameMap } from '../IdentityPresenter';

function registerCollabIssueTriageRoutes(app: CollabApp): void {
  // Issue triage: labels / assignees / milestone + meta
  app.get('/user/repos/:owner/:repo/issues/:number/meta', async (c) => {
    const owner = c.req.param('owner');
    const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
    const row = await requireVisibleRepo(c.env, owner, repoName, c.get('AuthenticatedUserEmailAddress'));
    if (!row) return jsonError(c, 'Not found', 404);
    const number = parseNumber(c.req.param('number'));
    if (number === null) return jsonError(c, 'Not found', 404);
    try {
      const scope = getScope(c);
      const issue = await scope.get(Tokens.IssueService).getByNumber(row.id, number);
      const meta = await getIssueMetaSafe(c.env, issue.id);
      const assigneeMap = await usernameMap(scope, meta.assignees);
      return c.json({
        issue: await presentSingle(scope, issue),
        labels: meta.labels,
        assignees: meta.assignees.map((e) => usernameFor(assigneeMap, e)),
        milestoneId: (issue as { milestone_id?: string | null }).milestone_id ?? null,
      });
    } catch (error) {
      return jsonError(c, toSafeErrorMessage(error, 'Not found'), toServiceStatus(error));
    }
  });

  for (const kind of ['labels', 'assignees', 'milestone'] as const) {
    app.put(`/user/repos/:owner/:repo/issues/:number/${kind}`, async (c) => {
      const email = c.get('AuthenticatedUserEmailAddress');
      const owner = c.req.param('owner');
      const repoName = RepoFullName.normalizeRepo(c.req.param('repo'));
      const row = await requireVisibleRepo(c.env, owner, repoName, email);
      if (!row) return jsonError(c, 'Not found', 404);
      if (!(await needWrite(c.env, owner, repoName, email))) return jsonError(c, 'Forbidden', 403);
      const number = parseNumber(c.req.param('number'));
      if (number === null) return jsonError(c, 'Not found', 404);
      const { malformed, body } = await readJsonBody<{ labelIds?: string[]; assignees?: string[]; milestoneId?: string | null }>(c);
      if (malformed) return jsonError(c, 'Invalid JSON body', 400);
      try {
        const scope = getScope(c);
        const issue = await scope.get(Tokens.IssueService).getByNumber(row.id, number);
        const collab = scope.get(Tokens.CollaborationService);
        if (kind === 'labels') await collab.setIssueLabels(issue.id, row.id, body.labelIds ?? []);
        else if (kind === 'assignees') await collab.setIssueAssignees(issue.id, body.assignees ?? []);
        else await collab.setIssueMilestone(issue.id, row.id, body.milestoneId ?? null);
        return c.json({ ok: true });
      } catch (error) {
        return jsonError(c, toSafeErrorMessage(error, 'Failed to update issue'), toServiceStatus(error));
      }
    });
  }
}

export { registerCollabIssueTriageRoutes };
