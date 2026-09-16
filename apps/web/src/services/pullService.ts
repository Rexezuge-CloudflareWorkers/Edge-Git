import type { MergePreview, PullComment, PullDiff, PullRequest, PullReview } from '../types';
import { apiGet, apiPatch, apiPost } from '../lib/api';

function authedBase(owner: string, repo: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
}

function publicBase(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
}

export async function listPulls(owner: string, repo: string): Promise<PullRequest[]> {
  try {
    const data = await apiGet<{ pulls?: PullRequest[] }>(authedBase(owner, repo));
    return data.pulls ?? [];
  } catch {
    const data = await apiGet<{ pulls?: PullRequest[] }>(publicBase(owner, repo));
    return data.pulls ?? [];
  }
}

export async function createPull(
  owner: string,
  repo: string,
  input: { title: string; body?: string; baseBranch: string; headBranch: string },
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

export async function getPull(owner: string, repo: string, number: number): Promise<PullRequest> {
  try {
    return unwrapPull(await apiGet<PullRequest | { pull?: PullRequest }>(authedPull(owner, repo, number)));
  } catch {
    return unwrapPull(await apiGet<PullRequest | { pull?: PullRequest }>(publicPull(owner, repo, number)));
  }
}

export async function listPullComments(owner: string, repo: string, number: number): Promise<PullComment[]> {
  try {
    const data = await apiGet<{ comments?: PullComment[] }>(`${authedPull(owner, repo, number)}/comments`);
    return data.comments ?? [];
  } catch {
    const data = await apiGet<{ comments?: PullComment[] }>(`${publicPull(owner, repo, number)}/comments`);
    return data.comments ?? [];
  }
}

export async function addPullComment(owner: string, repo: string, number: number, input: { body: string }): Promise<PullComment> {
  const data = await apiPost<PullComment | { comment?: PullComment }>(`${authedPull(owner, repo, number)}/comments`, input);
  const nested = (data as { comment?: PullComment }).comment;
  return nested ?? (data as PullComment);
}

export async function listPullReviews(owner: string, repo: string, number: number): Promise<PullReview[]> {
  try {
    const data = await apiGet<{ reviews?: PullReview[] }>(`${authedPull(owner, repo, number)}/reviews`);
    return data.reviews ?? [];
  } catch {
    const data = await apiGet<{ reviews?: PullReview[] }>(`${publicPull(owner, repo, number)}/reviews`);
    return data.reviews ?? [];
  }
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

export async function getPullDiff(owner: string, repo: string, number: number): Promise<PullDiff> {
  try {
    const data = await apiGet<PullDiff | { diff?: PullDiff }>(`${authedPull(owner, repo, number)}/diff`);
    return (data as { diff?: PullDiff }).diff ?? (data as PullDiff);
  } catch {
    const data = await apiGet<PullDiff | { diff?: PullDiff }>(`${publicPull(owner, repo, number)}/diff`);
    return (data as { diff?: PullDiff }).diff ?? (data as PullDiff);
  }
}

export async function getMergePreview(owner: string, repo: string, number: number): Promise<MergePreview | null> {
  try {
    const data = await apiGet<{ preview?: MergePreview | null }>(`${authedPull(owner, repo, number)}/preview`);
    return data.preview ?? null;
  } catch {
    const data = await apiGet<{ preview?: MergePreview | null }>(`${publicPull(owner, repo, number)}/preview`);
    return data.preview ?? null;
  }
}

export async function mergePull(
  owner: string,
  repo: string,
  number: number,
  input?: { message?: string; deleteHead?: boolean },
): Promise<{ pull: PullRequest; merge: { type?: string; commitOid?: string; deletedHead?: boolean } }> {
  return apiPost<{ pull: PullRequest; merge: { type?: string; commitOid?: string; deletedHead?: boolean } }>(`${authedPull(owner, repo, number)}/merge`, input ?? {});
}
