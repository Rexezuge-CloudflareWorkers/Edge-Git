import type { MergePreview, PullComment, PullDiff, PullRequest, PullReview } from '../types';
import { apiGet, apiPatch, apiPost } from '../lib/api';

function authedBase(owner: string, repo: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
}

function publicBase(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
}

export interface ReadOpts {
  isAuthed?: boolean | null;
}

async function tryAuthedFirst<T>(authedPath: string, publicPath: string, isAuthed?: boolean | null): Promise<T> {
  // Same Access 302 + CORS trap as repoService: anonymous viewers go
  // straight to the public read-model.
  if (isAuthed === false) {
    return apiGet<T>(publicPath);
  }
  try {
    return await apiGet<T>(authedPath);
  } catch {
    return apiGet<T>(publicPath);
  }
}

export async function listPulls(owner: string, repo: string, opts?: ReadOpts & { label?: string }): Promise<PullRequest[]> {
  const suffix = opts?.label ? `?label=${encodeURIComponent(opts.label)}` : '';
  const data = await tryAuthedFirst<{ pulls?: PullRequest[] }>(`${authedBase(owner, repo)}${suffix}`, `${publicBase(owner, repo)}${suffix}`, opts?.isAuthed);
  return data.pulls ?? [];
}

export async function createPull(
  owner: string,
  repo: string,
  input: { title: string; body?: string; baseBranch: string; headBranch: string; headOwner?: string; headRepo?: string; isDraft?: boolean },
): Promise<{ id: string; number: number }> {
  return apiPost<{ id: string; number: number }>(authedBase(owner, repo), input);
}

function authedPull(owner: string, repo: string, number: number): string {
  return `${authedBase(owner, repo)}/${encodeURIComponent(String(number))}`;
}

function publicPull(owner: string, repo: string, number: number): string {
  return `${publicBase(owner, repo)}/${encodeURIComponent(String(number))}`;
}

function unwrapPull(data: PullRequest | { pull?: PullRequest }): PullRequest {
  const nested = (data as { pull?: PullRequest }).pull;
  return nested ?? (data as PullRequest);
}

export async function getPull(owner: string, repo: string, number: number, opts?: ReadOpts): Promise<PullRequest> {
  return unwrapPull(
    await tryAuthedFirst<PullRequest | { pull?: PullRequest }>(authedPull(owner, repo, number), publicPull(owner, repo, number), opts?.isAuthed),
  );
}

export async function listPullComments(owner: string, repo: string, number: number, opts?: ReadOpts): Promise<PullComment[]> {
  const data = await tryAuthedFirst<{ comments?: PullComment[] }>(
    `${authedPull(owner, repo, number)}/comments`,
    `${publicPull(owner, repo, number)}/comments`,
    opts?.isAuthed,
  );
  return data.comments ?? [];
}

export async function addPullComment(owner: string, repo: string, number: number, input: { body: string }): Promise<PullComment> {
  const data = await apiPost<PullComment | { comment?: PullComment }>(`${authedPull(owner, repo, number)}/comments`, input);
  const nested = (data as { comment?: PullComment }).comment;
  return nested ?? (data as PullComment);
}

export async function listPullReviews(owner: string, repo: string, number: number, opts?: ReadOpts): Promise<PullReview[]> {
  const data = await tryAuthedFirst<{ reviews?: PullReview[] }>(
    `${authedPull(owner, repo, number)}/reviews`,
    `${publicPull(owner, repo, number)}/reviews`,
    opts?.isAuthed,
  );
  return data.reviews ?? [];
}

export async function addPullReview(
  owner: string,
  repo: string,
  number: number,
  input: { state: string; body?: string },
): Promise<PullReview> {
  const data = await apiPost<PullReview | { review?: PullReview }>(`${authedPull(owner, repo, number)}/reviews`, input);
  const nested = (data as { review?: PullReview }).review;
  return nested ?? (data as PullReview);
}

export async function updatePullStatus(owner: string, repo: string, number: number, status: 'open' | 'closed'): Promise<PullRequest> {
  return unwrapPull(await apiPatch<PullRequest | { pull?: PullRequest }>(authedPull(owner, repo, number), { status }));
}

export async function getPullDiff(owner: string, repo: string, number: number, opts?: ReadOpts): Promise<PullDiff> {
  const data = await tryAuthedFirst<PullDiff | { diff?: PullDiff }>(
    `${authedPull(owner, repo, number)}/diff`,
    `${publicPull(owner, repo, number)}/diff`,
    opts?.isAuthed,
  );
  return (data as { diff?: PullDiff }).diff ?? (data as PullDiff);
}

export async function getMergePreview(owner: string, repo: string, number: number, opts?: ReadOpts): Promise<MergePreview | null> {
  const data = await tryAuthedFirst<{ preview?: MergePreview | null }>(
    `${authedPull(owner, repo, number)}/preview`,
    `${publicPull(owner, repo, number)}/preview`,
    opts?.isAuthed,
  );
  return data.preview ?? null;
}

export async function mergePull(
  owner: string,
  repo: string,
  number: number,
  input?: { message?: string; deleteHead?: boolean; strategy?: 'merge' | 'squash' | 'rebase' },
): Promise<{ pull: PullRequest; merge: { type?: string; commitOid?: string; deletedHead?: boolean } }> {
  return apiPost<{ pull: PullRequest; merge: { type?: string; commitOid?: string; deletedHead?: boolean } }>(`${authedPull(owner, repo, number)}/merge`, input ?? {});
}
