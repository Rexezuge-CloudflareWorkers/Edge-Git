import { RepoFullName } from '@edge-git/shared/utils';
import type { RepositoryRow } from '@edge-git/backend-data/dao';
import { toRepoJson } from './PublicViewerResolver';

/**
 * Presenter for repository detail responses (Presenter pattern).
 *
 * Why: `RepoRoutes`, `UserRoutes`, and `SocialRoutes` triplicated the same
 * `toRepoJson + viewerCanManage + viewerRole + forksCount + social` spread
 * with divergent `starred/watching` aliases. Centralizing here keeps the
 * wire shape in one place and makes future field renames single-point.
 */
function toRepoDetailJson(
  row: RepositoryRow,
  role: string | null,
  extra: { forksCount?: number; social?: unknown } = {},
): Record<string, unknown> {
  const base = toRepoJson(row, role) as Record<string, unknown>;
  const social = (extra.social ?? {}) as Record<string, unknown>;
  const viewerStarred = social['viewerStarred'] ?? null;
  const viewerWatching = social['viewerWatching'] ?? null;
  const hasSocial = 'viewerStarred' in social;
  return {
    ...base,
    viewerCanManage: role === 'admin',
    viewerRole: role,
    ...(extra.forksCount !== undefined && { forksCount: extra.forksCount }),
    ...social,
    // Legacy aliases: older SPA builds read `starred/watching`.
    ...(hasSocial && { starred: viewerStarred, watching: viewerWatching }),
  };
}

function normalizeRepoParam(repoParam: string): string {
  return RepoFullName.normalizeRepo(repoParam);
}

export { toRepoDetailJson, normalizeRepoParam };
