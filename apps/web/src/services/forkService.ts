import type { Repo } from '../types';
import { apiGet, apiPost } from '../lib/api';

export interface ForkInput {
  owner?: string;
  name?: string;
  description?: string | null;
  isPrivate?: boolean;
}

export interface CreatedFork {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  forkedFrom: string;
  isPrivate: boolean;
}

function authedForks(owner: string, repo: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/forks`;
}

function publicForks(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/forks`;
}

export async function forkRepo(owner: string, repo: string, input: ForkInput): Promise<CreatedFork> {
  return apiPost<CreatedFork>(authedForks(owner, repo), input);
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

export async function listForks(
  owner: string,
  repo: string,
  opts?: { isAuthed?: boolean | null },
): Promise<{ forks: Repo[]; count: number }> {
  const data = await tryAuthedFirst<{ forks?: Repo[]; count?: number }>(authedForks(owner, repo), publicForks(owner, repo), opts?.isAuthed);
  return { forks: data.forks ?? [], count: data.count ?? data.forks?.length ?? 0 };
}
