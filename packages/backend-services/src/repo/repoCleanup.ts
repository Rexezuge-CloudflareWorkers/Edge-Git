import type {
  AuditLogDAO,
  BranchProtectionDAO,
  CheckRunDAO,
  CollaborationDAO,
  DeployKeyDAO,
  DiscussionDAO,
  EventDAO,
  ImportDAO,
  IssueDAO,
  MirrorDAO,
  NotificationDAO,
  ProjectDAO,
  PullRequestDAO,
  PullThreadDAO,
  ReleaseDAO,
  RepoCollaboratorDAO,
  SecuritySettingsDAO,
  StarDAO,
  TeamRepoGrantDAO,
  TokenRepoGrantDAO,
  WatchDAO,
  WebhookDAO,
  WebhookDeliveryDAO,
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
  importDAO: () => Promise<ImportDAO>;
  mirrorDAO: () => Promise<MirrorDAO>;
  deployKeyDAO: () => Promise<DeployKeyDAO>;
  tokenGrantDAO: () => Promise<TokenRepoGrantDAO>;
  securitySettingsDAO: () => Promise<SecuritySettingsDAO>;
  collaborationDAO: () => Promise<CollaborationDAO>;
  webhookDAO: () => Promise<WebhookDAO>;
  webhookDeliveryDAO: () => Promise<WebhookDeliveryDAO>;
  auditLogDAO: () => Promise<AuditLogDAO>;
  teamGrantDAO: () => Promise<TeamRepoGrantDAO>;
  checkRunDAO: () => Promise<CheckRunDAO>;
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
    deps.importDAO,
    deps.mirrorDAO,
    deps.deployKeyDAO,
    deps.tokenGrantDAO,
    deps.securitySettingsDAO,
    deps.collaborationDAO,
    deps.webhookDAO,
    deps.webhookDeliveryDAO,
    deps.auditLogDAO,
    deps.teamGrantDAO,
  ];
  for (const factory of factories) {
    try {
      const dao = await factory();
      await dao.deleteByRepo(repoId);
    } catch {
      // ignore — legacy DBs without the table
    }
  }
  // Check runs prune by time (no deleteByRepo); best-effort purge via a wide
  // cutoff so deletes do not leave check history orphaned on new DBs.
  try {
    const checkDao = await deps.checkRunDAO();
    if (typeof (checkDao as unknown as { deleteByRepo?: (id: string) => Promise<unknown> }).deleteByRepo === 'function') {
      await (checkDao as unknown as { deleteByRepo: (id: string) => Promise<unknown> }).deleteByRepo(repoId);
    }
  } catch {
    // ignore — legacy DBs without the table
  }
}

export { cleanupRepoSidecars };
export type { RepoCleanupDeps };
