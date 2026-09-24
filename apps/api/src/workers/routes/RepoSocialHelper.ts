import { getScope } from './PublicViewerResolver';
import { Tokens } from '@edge-git/backend-services/composition';

interface RepoSocial {
  starsCount: number;
  watchersCount: number;
  viewerStarred: boolean;
  viewerWatching: boolean;
}

// Extracted from `RepoRoutes.ts` (god-file guard): shared social read for the
// repo payload. Counts always resolve (0 on error), viewer flags resolve
// best-effort and default to false for anonymous visitors.
async function getRepoSocial(
  scope: ReturnType<typeof getScope>,
  repoId: string,
  viewerEmail: string | null,
): Promise<RepoSocial> {
  const [starsCount, watchersCount, viewerStarred, viewerWatching] = await Promise.all([
    scope
      .get(Tokens.StarService)
      .countByRepo(repoId)
      .catch(() => 0),
    scope
      .get(Tokens.WatchService)
      .countByRepo(repoId)
      .catch(() => 0),
    viewerEmail
      ? scope
          .get(Tokens.StarService)
          .isStarred(repoId, viewerEmail)
          .catch(() => false)
      : Promise.resolve(false),
    viewerEmail
      ? scope
          .get(Tokens.WatchService)
          .isWatching(repoId, viewerEmail)
          .catch(() => false)
      : Promise.resolve(false),
  ]);
  return { starsCount, watchersCount, viewerStarred, viewerWatching };
}

export { getRepoSocial };
export type { RepoSocial };
