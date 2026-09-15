import type { Issue } from '../types';
import { apiGet, apiPost } from '../lib/api';

function authedBase(owner: string, repo: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
}

function publicBase(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
}

export async function listIssues(owner: string, repo: string): Promise<Issue[]> {
  try {
    const data = await apiGet<{ issues?: Issue[] }>(authedBase(owner, repo));
    return data.issues ?? [];
  } catch {
    const data = await apiGet<{ issues?: Issue[] }>(publicBase(owner, repo));
    return data.issues ?? [];
  }
}

export async function createIssue(
  owner: string,
  repo: string,
  input: { title: string; body?: string },
): Promise<{ id: string; number: number }> {
  return apiPost<{ id: string; number: number }>(authedBase(owner, repo), input);
}
