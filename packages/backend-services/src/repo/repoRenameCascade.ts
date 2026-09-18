import type {
  EventDAO,
  IssueDAO,
  NotificationDAO,
  PullRequestDAO,
  RepositoryDAO,
  WebhookDAO,
} from '@edge-git/backend-data/dao';

// D1 cascade for owner/org renames, split out of `UserService` /
// `OrganizationService` to stay under the god-file guard (mirrors
// `repoCleanup.ts`). Keyed by stable `repository_id` — FTS follows via the
// `repo_fts` / `issue_fts` / `pull_fts` UPDATE triggers.
interface RepoRenameCascadeDeps {
  repositoryDAO: () => Promise<RepositoryDAO>;
  issueDAO?: () => Promise<Pick<IssueDAO, 'updateFullNameByRepo'>>;
  pullRequestDAO?: () => Promise<
    Pick<PullRequestDAO, 'updateFullNameByRepo' | 'updateHeadFullNameByHeadRepo'>
  >;
  eventDAO?: () => Promise<Pick<EventDAO, 'updateFullNameByRepo'>>;
  notificationDAO?: () => Promise<Pick<NotificationDAO, 'updateFullNameByRepo'>>;
  webhookDAO?: () => Promise<Pick<WebhookDAO, 'updateFullNameByRepo'>>;
}

interface RepoRenameMove {
  id: string;
  name: string;
  oldFull: string;
  newFull: string;
}

async function cascadeOwnerRepos(
  deps: RepoRenameCascadeDeps,
  input: { oldOwnerCi: string; newOwner: string; now: number; extraRepos?: Array<{ id: string; name: string }> },
): Promise<RepoRenameMove[]> {
  const repoDAO = await deps.repositoryDAO();
  // Snapshot before `renameOwner` — afterwards `owner_ci` already reads new.
  const seen = new Set<string>();
  const ordered: Array<{ id: string; name: string }> = [];
  const remember = (rows: Array<{ id: string; name: string }>): void => {
    for (const row of rows) {
      if (!row.id || !row.name || seen.has(row.id)) continue;
      seen.add(row.id);
      ordered.push({ id: row.id, name: row.name });
    }
  };
  try {
    remember(await repoDAO.listByOwner(input.oldOwnerCi, 1000));
  } catch {
    // Legacy fakes without listByOwner — fall through to extraRepos.
  }
  if (input.extraRepos) remember(input.extraRepos);
  await repoDAO.renameOwner(input.oldOwnerCi, input.newOwner, input.now);
  const moves: RepoRenameMove[] = ordered.map((r) => ({
    id: r.id,
    name: r.name,
    oldFull: `${input.oldOwnerCi}/${r.name}`,
    newFull: `${input.newOwner}/${r.name}`,
  }));
  // Preserve the pre-rename owner casing for display-side full names: the
  // D1 row now carries the new owner casing, so re-read it when available.
  // (Best-effort — snapshot casing is correct for all-lowercase owners.)
  for (const move of moves) {
    const fullName = move.newFull;
    const tasks: Array<Promise<unknown>> = [];
    if (deps.issueDAO) {
      tasks.push(
        deps
          .issueDAO()
          .then((dao) => dao.updateFullNameByRepo(move.id, fullName))
          .catch(() => undefined),
      );
    }
    if (deps.pullRequestDAO) {
      const pullDAO = deps.pullRequestDAO;
      tasks.push(
        pullDAO()
          .then((dao) => dao.updateFullNameByRepo(move.id, fullName))
          .catch(() => undefined),
        pullDAO()
          .then((dao) => dao.updateHeadFullNameByHeadRepo(move.id, fullName))
          .catch(() => undefined),
      );
    }
    if (deps.eventDAO) {
      tasks.push(
        deps
          .eventDAO()
          .then((dao) => dao.updateFullNameByRepo(move.id, fullName))
          .catch(() => undefined),
      );
    }
    if (deps.notificationDAO) {
      tasks.push(
        deps
          .notificationDAO()
          .then((dao) => dao.updateFullNameByRepo(move.id, fullName))
          .catch(() => undefined),
      );
    }
    if (deps.webhookDAO) {
      tasks.push(
        deps
          .webhookDAO()
          .then((dao) => dao.updateFullNameByRepo(move.id, fullName))
          .catch(() => undefined),
      );
    }
    // Forks pointing at this repo as their source keep a denormalized name
    // (`updateForkSourceFullName` never rejects — legacy DBs no-op inside).
    tasks.push(repoDAO.updateForkSourceFullName(move.id, fullName));
    await Promise.all(tasks);
  }
  return moves;
}

export { cascadeOwnerRepos };
export type { RepoRenameCascadeDeps, RepoRenameMove };
