import type {
  BlobResponse,
  BranchesResponse,
  CommitDiffResult,
  CompareResult,
  FileCommitResult,
  GitCommit,
  OverviewResponse,
  Repo,
  TagInfo,
  TreeEntry,
} from '../types';
import { apiAuthedFirst, apiDelete, apiGet, apiPatch, apiPost, buildQuery } from '../lib/api';

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

export async function updateRepo(owner: string, repo: string, patch: { description?: string | null; isPrivate?: boolean }): Promise<Repo> {
  return apiPatch<Repo>(authedBase(owner, repo), patch);
}

export async function deleteRepo(owner: string, repo: string): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(authedBase(owner, repo));
}

// Public repo fetch (anonymous OK for public repos; 404 otherwise).
export async function loadRepoPublic(owner: string, repo: string): Promise<Repo> {
  return apiGet<Repo>(publicBase(owner, repo));
}

async function tryAuthedFirst<T>(authedPath: string, publicPath: string, isAuthed?: boolean | null): Promise<T> {
  return apiAuthedFirst<T>(authedPath, publicPath, isAuthed);
}

export async function loadBranches(owner: string, repo: string, opts?: { isAuthed?: boolean | null }): Promise<BranchesResponse> {
  return tryAuthedFirst(`${authedBase(owner, repo)}/branches`, `${publicBase(owner, repo)}/branches`, opts?.isAuthed);
}

export async function loadTags(owner: string, repo: string, opts?: { isAuthed?: boolean | null }): Promise<TagInfo[]> {
  return tryAuthedFirst(`${authedBase(owner, repo)}/tags`, `${publicBase(owner, repo)}/tags`, opts?.isAuthed);
}

export async function createBranch(
  owner: string,
  repo: string,
  name: string,
  from?: string,
): Promise<{ branch?: string; ref?: string; oid?: string }> {
  return apiPost(`${authedBase(owner, repo)}/branches`, { name, from });
}

export async function deleteBranch(owner: string, repo: string, branch: string): Promise<{ deleted?: boolean }> {
  const base = authedBase(owner, repo);
  const url = `${base}/branches${toQuery({ branch })}`;
  return apiDelete(url);
}

export async function setDefaultBranch(owner: string, repo: string, branch: string): Promise<{ defaultBranch: string }> {
  return apiPatch(`${authedBase(owner, repo)}/branches/default`, { branch });
}

function encodeTextToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function saveFile(
  owner: string,
  repo: string,
  input: { branch: string; path: string; content: string; message?: string; expectedOid?: string },
): Promise<FileCommitResult> {
  return apiPost<FileCommitResult>(`${authedBase(owner, repo)}/contents`, {
    branch: input.branch,
    path: input.path,
    contentBase64: encodeTextToBase64(input.content),
    message: input.message,
    expectedOid: input.expectedOid,
  });
}

export async function deleteFile(
  owner: string,
  repo: string,
  input: { branch: string; path: string; message?: string; expectedOid?: string },
): Promise<FileCommitResult> {
  const base = authedBase(owner, repo);
  const url = `${base}/contents${toQuery({ branch: input.branch, path: input.path, message: input.message, expectedOid: input.expectedOid })}`;
  return apiDelete<FileCommitResult>(url);
}

export async function loadTree(
  owner: string,
  repo: string,
  ref?: string,
  path?: string,
  opts?: { isAuthed?: boolean | null; withLastCommit?: boolean },
): Promise<TreeEntry[]> {
  const query = toQuery({
    ref,
    path,
    withLastCommit: opts?.withLastCommit === false ? '0' : opts?.withLastCommit === true ? '1' : undefined,
  });
  return tryAuthedFirst(`${authedBase(owner, repo)}/tree${query}`, `${publicBase(owner, repo)}/tree${query}`, opts?.isAuthed);
}

export async function loadBlob(
  owner: string,
  repo: string,
  path: string,
  ref?: string,
  opts?: { isAuthed?: boolean | null },
): Promise<BlobResponse | null> {
  return tryAuthedFirst(
    `${authedBase(owner, repo)}/blob${toQuery({ ref, path })}`,
    `${publicBase(owner, repo)}/blob${toQuery({ ref, path })}`,
    opts?.isAuthed,
  );
}

export async function loadCommits(
  owner: string,
  repo: string,
  ref?: string,
  depth = 20,
  opts?: { isAuthed?: boolean | null },
): Promise<GitCommit[]> {
  return tryAuthedFirst(
    `${authedBase(owner, repo)}/commits${toQuery({ ref, depth: String(depth) })}`,
    `${publicBase(owner, repo)}/commits${toQuery({ ref, depth: String(depth) })}`,
    opts?.isAuthed,
  );
}

// Aggregate code-page read: branches + tags + fast tree + commits + README
// in one backend round-trip (single DO RPC). Replaces the sequential
// branches/tags/tree/commits/blob waterfall on owner/repo load.
export async function loadOverview(
  owner: string,
  repo: string,
  ref?: string,
  path?: string,
  opts?: { isAuthed?: boolean | null; depth?: number; includeTags?: boolean; includeReadme?: boolean },
): Promise<OverviewResponse> {
  const query = toQuery({
    ref,
    path,
    depth: opts?.depth === undefined ? undefined : String(opts.depth),
    includeTags: opts?.includeTags === false ? '0' : opts?.includeTags === true ? '1' : undefined,
    includeReadme: opts?.includeReadme === false ? '0' : opts?.includeReadme === true ? '1' : undefined,
  });
  return tryAuthedFirst(`${authedBase(owner, repo)}/overview${query}`, `${publicBase(owner, repo)}/overview${query}`, opts?.isAuthed);
}

export async function loadCommit(
  owner: string,
  repo: string,
  oid: string,
  opts?: { isAuthed?: boolean | null },
): Promise<CommitDiffResult> {
  return tryAuthedFirst(
    `${authedBase(owner, repo)}/commits/${encodeURIComponent(oid)}`,
    `${publicBase(owner, repo)}/commits/${encodeURIComponent(oid)}`,
    opts?.isAuthed,
  );
}

export async function loadCompare(
  owner: string,
  repo: string,
  base: string,
  head: string,
  opts?: { isAuthed?: boolean | null },
): Promise<CompareResult> {
  return tryAuthedFirst(
    `${authedBase(owner, repo)}/compare${toQuery({ base, head })}`,
    `${publicBase(owner, repo)}/compare${toQuery({ base, head })}`,
    opts?.isAuthed,
  );
}

function toQuery(params: Record<string, string | undefined>): string {
  const qs = buildQuery(params);
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
