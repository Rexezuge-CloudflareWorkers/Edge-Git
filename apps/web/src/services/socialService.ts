import type { Repo, RepoEvent } from '../types';
import { apiAuthedFirst, apiDelete, apiGet, apiPut } from '../lib/api';

function authedBase(owner: string, repo: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function publicBase(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export interface StarState {
  count: number;
  starsCount: number;
  viewerStarred: boolean;
  starred?: boolean;
  watchersCount?: number;
}

export interface WatchState {
  count: number;
  watchersCount: number;
  viewerWatching: boolean;
  watching?: boolean;
  starsCount?: number;
}

export interface SocialReadOpts {
  isAuthed?: boolean | null;
}

export async function getStarState(owner: string, repo: string, opts?: SocialReadOpts): Promise<StarState> {
  return apiAuthedFirst<StarState>(`${authedBase(owner, repo)}/star`, `${publicBase(owner, repo)}/stars`, opts?.isAuthed);
}

export async function getWatchState(owner: string, repo: string, opts?: SocialReadOpts): Promise<WatchState> {
  return apiAuthedFirst<WatchState>(`${authedBase(owner, repo)}/watch`, `${publicBase(owner, repo)}/watches`, opts?.isAuthed);
}

export async function starRepo(owner: string, repo: string): Promise<StarState & { starred: boolean }> {
  return apiPut(`${authedBase(owner, repo)}/star`);
}

export async function unstarRepo(owner: string, repo: string): Promise<StarState & { starred: boolean }> {
  return apiDelete(`${authedBase(owner, repo)}/star`);
}

export async function watchRepo(owner: string, repo: string): Promise<WatchState & { watching: boolean }> {
  return apiPut(`${authedBase(owner, repo)}/watch`);
}

export async function unwatchRepo(owner: string, repo: string): Promise<WatchState & { watching: boolean }> {
  return apiDelete(`${authedBase(owner, repo)}/watch`);
}

export async function listStarredRepos(): Promise<Repo[]> {
  const data = await apiGet<{ repos?: Repo[] }>('/user/stars');
  return data.repos ?? [];
}

export async function listWatchedRepos(): Promise<Repo[]> {
  const data = await apiGet<{ repos?: Repo[] }>('/user/watches');
  return data.repos ?? [];
}

export async function listActivity(
  owner: string,
  repo: string,
  cursor?: string,
  limit = 30,
): Promise<{ events: RepoEvent[]; nextCursor: string | null }> {
  const params: Record<string, string> = { limit: String(limit) };
  if (cursor) params.cursor = cursor;
  const qs = new URLSearchParams(params).toString();
  return apiGet<{ events: RepoEvent[]; nextCursor: string | null }>(`${publicBase(owner, repo)}/activity?${qs}`);
}
