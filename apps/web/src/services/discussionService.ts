import type { Discussion, DiscussionCategory, DiscussionComment } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';

function authedBase(owner: string, repo: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function publicBase(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function tryAuthedFirst<T>(authedPath: string, publicPath: string, isAuthed?: boolean | null): Promise<T> {
  if (isAuthed === false) return apiGet<T>(publicPath);
  try {
    return await apiGet<T>(authedPath);
  } catch {
    return apiGet<T>(publicPath);
  }
}

export async function listDiscussionCategories(
  owner: string,
  repo: string,
  opts?: { isAuthed?: boolean | null },
): Promise<DiscussionCategory[]> {
  const data = await tryAuthedFirst<{ categories?: DiscussionCategory[] }>(
    `${authedBase(owner, repo)}/discussions/categories`,
    `${publicBase(owner, repo)}/discussions/categories`,
    opts?.isAuthed,
  );
  return data.categories ?? [];
}

export async function listDiscussions(
  owner: string,
  repo: string,
  category?: string,
  opts?: { isAuthed?: boolean | null },
): Promise<Discussion[]> {
  const authed = category
    ? `${authedBase(owner, repo)}/discussions?category=${encodeURIComponent(category)}`
    : `${authedBase(owner, repo)}/discussions`;
  const pub = category
    ? `${publicBase(owner, repo)}/discussions?category=${encodeURIComponent(category)}`
    : `${publicBase(owner, repo)}/discussions`;
  const data = await tryAuthedFirst<{ discussions?: Discussion[] }>(authed, pub, opts?.isAuthed);
  return data.discussions ?? [];
}

export async function loadDiscussion(
  owner: string,
  repo: string,
  number: number,
  opts?: { isAuthed?: boolean | null },
): Promise<{ discussion: Discussion; comments: DiscussionComment[] }> {
  return tryAuthedFirst(
    `${authedBase(owner, repo)}/discussions/${number}`,
    `${publicBase(owner, repo)}/discussions/${number}`,
    opts?.isAuthed,
  );
}

export async function createDiscussion(
  owner: string,
  repo: string,
  input: { title: string; body?: string | null; categorySlug?: string },
): Promise<{ discussion: Discussion }> {
  return apiPost(`${authedBase(owner, repo)}/discussions`, input);
}

export async function updateDiscussion(
  owner: string,
  repo: string,
  number: number,
  patch: { title?: string; body?: string | null; categorySlug?: string | null; status?: 'open' | 'locked' | 'answered' },
): Promise<{ discussion: Discussion }> {
  return apiPatch(`${authedBase(owner, repo)}/discussions/${number}`, patch);
}

export async function deleteDiscussion(owner: string, repo: string, number: number): Promise<{ ok: boolean }> {
  return apiDelete(`${authedBase(owner, repo)}/discussions/${number}`);
}

export async function addDiscussionComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
): Promise<{ comment: DiscussionComment }> {
  return apiPost(`${authedBase(owner, repo)}/discussions/${number}/comments`, { body });
}

export async function deleteDiscussionComment(owner: string, repo: string, number: number, commentId: string): Promise<{ ok: boolean }> {
  return apiDelete(`${authedBase(owner, repo)}/discussions/${number}/comments/${encodeURIComponent(commentId)}`);
}
