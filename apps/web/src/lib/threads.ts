import type { PullReviewThread } from '../types';

export interface ReviewGateView {
  author: string;
  /** @deprecated Transitional: API now returns `author`. */
  author_email?: string;
  state: string;
  dismissed?: number | null;
}

function isDismissed(review: ReviewGateView): boolean {
  return review.dismissed === 1;
}

/**
 * Latest review per author (lowercased email), oldest-first wins on ties —
 * mirrors `PullRequestService.isBlockedByReviews`. Dismissed reviews are
 * excluded but stay visible for audit.
 */
export function latestReviewsByAuthor(reviews: readonly ReviewGateView[]): Map<string, ReviewGateView> {
  const latest = new Map<string, ReviewGateView>();
  for (const review of reviews) {
    if (isDismissed(review)) continue;
    const key = (review.author ?? (review as { author_email?: unknown }).author_email) as string;
    latest.set(key.toLowerCase(), review);
  }
  return latest;
}

export function isBlockedByReviews(reviews: readonly ReviewGateView[]): boolean {
  for (const review of latestReviewsByAuthor(reviews).values()) {
    if (review.state === 'changes_requested') return true;
  }
  return false;
}

export function countApprovals(reviews: readonly ReviewGateView[], creatorEmail: string): number {
  const creator = creatorEmail.toLowerCase();
  let approvals = 0;
  for (const [author, review] of latestReviewsByAuthor(reviews)) {
    if (author !== creator && review.state === 'approved') approvals += 1;
  }
  return approvals;
}

/**
 * CODEOWNERS quorum: when owners resolve for the changed paths, at least one
 * non-creator owner approval is required. Mirrors
 * `BranchProtectionService.checkMergeBlocked` (codeowners branch).
 */
export function isBlockedByCodeowners(reviews: readonly ReviewGateView[], creatorEmail: string, owners: readonly string[]): boolean {
  if (owners.length === 0) return false;
  const creator = creatorEmail.toLowerCase();
  const wanted = new Set(owners.map((o) => o.toLowerCase()));
  for (const [author, review] of latestReviewsByAuthor(reviews)) {
    if (author !== creator && review.state === 'approved' && wanted.has(author)) return false;
  }
  return true;
}

export function groupThreadsByPath(threads: readonly PullReviewThread[]): Map<string, PullReviewThread[]> {
  const groups = new Map<string, PullReviewThread[]>();
  for (const thread of threads) {
    const list = groups.get(thread.path) ?? [];
    list.push(thread);
    groups.set(thread.path, list);
  }
  return groups;
}

export function countOpenThreads(threads: readonly Pick<PullReviewThread, 'status'>[]): number {
  return threads.filter((t) => t.status === 'open').length;
}

export function threadLabel(thread: { path: string; line?: number | null; side: string }): string {
  if (thread.line === null || thread.line === undefined) return thread.path;
  return `${thread.path}:${thread.line} (${thread.side})`;
}
