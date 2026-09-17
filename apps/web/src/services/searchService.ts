import type { Issue, PullRequest, Repo } from '../types';
import { apiGet } from '../lib/api';

export type SearchType = 'repos' | 'issues' | 'pulls' | 'code';

export interface CodeHit {
  repo_id: string;
  path: string;
  oid: string | null;
  content: string;
  snippet: string;
}

export async function searchRepos(query: string, limit = 20): Promise<Repo[]> {
  const data = await apiGet<{ repos?: Repo[] }>('/search', { q: query, type: 'repos', limit: String(limit) });
  return data.repos ?? [];
}

export async function searchIssues(query: string, limit = 20, scope?: { owner?: string; repo?: string }): Promise<Issue[]> {
  const data = await apiGet<{ issues?: Issue[] }>('/search', {
    q: query,
    type: 'issues',
    limit: String(limit),
    owner: scope?.owner,
    repo: scope?.repo,
  });
  return data.issues ?? [];
}
export async function searchCode(query: string, limit = 20, scope?: { owner?: string; repo?: string }): Promise<CodeHit[]> {
  const data = await apiGet<{ code?: CodeHit[] }>('/search', {
    q: query,
    type: 'code',
    limit: String(limit),
    owner: scope?.owner,
    repo: scope?.repo,
  });
  return data.code ?? [];
}

export async function searchPulls(query: string, limit = 20, scope?: { owner?: string; repo?: string }): Promise<PullRequest[]> {
  const data = await apiGet<{ pulls?: PullRequest[] }>('/search', {
    q: query,
    type: 'pulls',
    limit: String(limit),
    owner: scope?.owner,
    repo: scope?.repo,
  });
  return data.pulls ?? [];
}
