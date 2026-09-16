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

export async function listForks(owner: string, repo: string): Promise<{ forks: Repo[]; count: number }> {
  try {
    const data = await apiGet<{ forks?: Repo[]; count?: number }>(authedForks(owner, repo));
    return { forks: data.forks ?? [], count: data.count ?? data.forks?.length ?? 0 };
  } catch {
    const data = await apiGet<{ forks?: Repo[]; count?: number }>(publicForks(owner, repo));
    return { forks: data.forks ?? [], count: data.count ?? data.forks?.length ?? 0 };
  }
}
