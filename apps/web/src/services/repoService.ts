import type { BlobResponse, BranchesResponse, GitCommit, Repo, TreeEntry } from '../types';
import { apiGet, apiPost } from '../lib/api';

function authedBase(owner: string, repo: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function publicBase(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export async function listMyRepos(): Promise<Repo[]> {
  const data = await apiGet<{ repos?: Repo[] }>('/user/repos');
  return data.repos ?? [];
}

export async function createRepo(input: { owner?: string; name: string; description?: string | null; isPrivate?: boolean }): Promise<Repo> {
  return apiPost<Repo>('/user/repos', input);
}

// Authenticated repo fetch (works for own + visible repos when logged in).
export async function loadRepoAuthed(owner: string, repo: string): Promise<Repo> {
  return apiGet<Repo>(authedBase(owner, repo));
}

// Public repo fetch (anonymous OK for public repos; 404 otherwise).
export async function loadRepoPublic(owner: string, repo: string): Promise<Repo> {
  return apiGet<Repo>(publicBase(owner, repo));
}

async function tryAuthedFirst<T>(owner: string, repo: string, authedPath: string, publicPath: string): Promise<T> {
  try {
    return await apiGet<T>(authedPath);
  } catch {
    return apiGet<T>(publicPath);
  }
}

export async function loadBranches(owner: string, repo: string): Promise<BranchesResponse> {
  return tryAuthedFirst(owner, repo, `${authedBase(owner, repo)}/branches`, `${publicBase(owner, repo)}/branches`);
}

export async function loadTree(owner: string, repo: string, ref?: string, path?: string): Promise<TreeEntry[]> {
  return tryAuthedFirst(
    owner,
    repo,
    `${authedBase(owner, repo)}/tree${toQuery({ ref, path })}`,
    `${publicBase(owner, repo)}/tree${toQuery({ ref, path })}`,
  );
}

export async function loadBlob(owner: string, repo: string, path: string, ref?: string): Promise<BlobResponse | null> {
  return tryAuthedFirst(
    owner,
    repo,
    `${authedBase(owner, repo)}/blob${toQuery({ ref, path })}`,
    `${publicBase(owner, repo)}/blob${toQuery({ ref, path })}`,
  );
}

export async function loadCommits(owner: string, repo: string, ref?: string, depth = 20): Promise<GitCommit[]> {
  return tryAuthedFirst(
    owner,
    repo,
    `${authedBase(owner, repo)}/commits${toQuery({ ref, depth: String(depth) })}`,
    `${publicBase(owner, repo)}/commits${toQuery({ ref, depth: String(depth) })}`,
  );
}

function toQuery(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, v);
  }
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}

export function decodeBlobContent(blob: BlobResponse | null): string | null {
  if (!blob || blob.isBinary || !blob.contentBase64) return null;
  try {
    const binary = atob(blob.contentBase64);
    const bytes = Uint8Array.from(binary, (c) => c.codePointAt(0) ?? 0);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
