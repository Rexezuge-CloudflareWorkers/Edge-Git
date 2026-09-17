import type {
  BranchProtectionDAO,
  DiscussionDAO,
  EventDAO,
  IssueDAO,
  NotificationDAO,
  ProjectDAO,
  PullRequestDAO,
  PullThreadDAO,
  ReleaseDAO,
  RepoCollaboratorDAO,
  StarDAO,
  WatchDAO,
  WikiDAO,
} from '@edge-git/backend-data/dao';

// Best-effort sidecar cleanup for `RepoService.deleteRepo`, split out of
// `RepoService.ts` to stay under the god-file guard. Each step tolerates
// legacy DBs missing the table. Issues are hard-required (v1 tables); the
// rest degrade silently.
interface RepoCleanupDeps {
  issueDAO: () => Promise<IssueDAO>;
  pullRequestDAO: () => Promise<PullRequestDAO>;
  pullThreadDAO: () => Promise<PullThreadDAO>;
  branchProtectionDAO: () => Promise<BranchProtectionDAO>;
  repoCollaboratorDAO: () => Promise<RepoCollaboratorDAO>;
  starDAO: () => Promise<StarDAO>;
  watchDAO: () => Promise<WatchDAO>;
  eventDAO: () => Promise<EventDAO>;
  notificationDAO: () => Promise<NotificationDAO>;
  releaseDAO: () => Promise<ReleaseDAO>;
  projectDAO: () => Promise<ProjectDAO>;
  discussionDAO: () => Promise<DiscussionDAO>;
  wikiDAO: () => Promise<WikiDAO>;
}

async function cleanupRepoSidecars(deps: RepoCleanupDeps, repoId: string): Promise<void> {
  const issueDAO = await deps.issueDAO();
  await issueDAO.deleteByRepo(repoId);
  const factories: Array<() => Promise<{ deleteByRepo(repoId: string): Promise<unknown> }>> = [
    deps.pullRequestDAO,
    deps.pullThreadDAO,
    deps.branchProtectionDAO,
    deps.repoCollaboratorDAO,
    deps.starDAO,
    deps.watchDAO,
    deps.eventDAO,
    deps.notificationDAO,
    deps.releaseDAO,
    deps.projectDAO,
    deps.discussionDAO,
    deps.wikiDAO,
  ];
  for (const factory of factories) {
    try {
      const dao = await factory();
      await dao.deleteByRepo(repoId);
    } catch {
      // ignore — legacy DBs without the table
    }
  }
}

export { cleanupRepoSidecars };
export type { RepoCleanupDeps };
