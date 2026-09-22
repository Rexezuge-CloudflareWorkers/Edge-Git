import type { RepositoryRow } from '@edge-git/backend-data/dao';

/**
 * Pure profile-visibility helpers for public user/org pages.
 *
 * Extracted from `UserRoutes` (god-file guard): limit parsing and
 * viewer-visibility fan-out live here so they are unit-testable without
 * Hono or D1. `UserRoutes` remains the thin route facade and re-exports
 * these symbols for compatibility.
 */

const PROFILE_REPO_SCAN_CAP = 200;

function parseLimit(url: string): number {
  try {
    const raw = new URL(url).searchParams.get('limit');
    // Invalid values fall back to a safe default (20), never to the max:
    // `?limit=abc` must not silently become a 100-row over-fetch.
    // Numeric out-of-range values clamp (0→1, 500→100); non-numeric →20.
    if (raw === null || raw.trim() === '') return 20;
    const n = Number(raw.trim());
    if (!Number.isFinite(n)) return 20;
    return Math.min(100, Math.max(1, Math.floor(n)));
  } catch {
    return 20;
  }
}

async function filterVisibleRepos(
  repos: RepositoryRow[],
  getRole: (repo: RepositoryRow) => Promise<string | null>,
  limit: number,
): Promise<Array<{ row: RepositoryRow; role: string }>> {
  const scanned = repos.slice(0, PROFILE_REPO_SCAN_CAP);
  const roles = await Promise.all(scanned.map((repo) => getRole(repo).catch(() => null)));
  const visible: Array<{ row: RepositoryRow; role: string }> = [];
  for (const [index, row] of scanned.entries()) {
    const role = roles[index];
    if (role) visible.push({ row, role });
    if (visible.length >= limit) break;
  }
  return visible;
}

async function hasVisibleRepo(repos: RepositoryRow[], getRole: (repo: RepositoryRow) => Promise<string | null>): Promise<boolean> {
  const scanned = repos.slice(0, 20);
  // Fail closed per repo (mirrors `filterVisibleRepos`): a transient D1
  // failure hides the repo instead of surfacing a 500 existence oracle.
  const roles = await Promise.all(scanned.map((repo) => getRole(repo).catch(() => null)));
  return roles.some((role) => role !== null);
}

/**
 * Pure org/user repo dedup (Specification): merges `listByOrgId` +
 * `listByOwner` rows by id so profile counts never double-count repos
 * present in both listings. Extracted from `UserRoutes` where the
 * Map-based merge was duplicated in two handlers.
 */
function deduplicateRepoRows<T extends { id: string }>(...lists: T[][]): T[] {
  const seen = new Map<string, T>();
  for (const list of lists) for (const row of list) seen.set(row.id, row);
  return Array.from(seen.values());
}

export { PROFILE_REPO_SCAN_CAP, filterVisibleRepos, hasVisibleRepo, parseLimit, deduplicateRepoRows };
