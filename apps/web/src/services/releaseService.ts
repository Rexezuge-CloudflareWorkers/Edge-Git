import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';

export interface Release {
  id: string;
  repositoryId: string;
  tagName: string;
  name: string;
  body: string;
  isDraft: boolean;
  isPrerelease: boolean;
  createdBy: string;
  createdAt: number;
  publishedAt: number | null;
}

export interface ReleaseAsset {
  id: string;
  releaseId: string;
  repositoryId: string;
  name: string;
  size: number;
  contentType: string;
  sha256: string;
  createdBy: string;
  createdAt: number;
}

function authedBase(owner: string, repo: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function publicBase(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function tryAuthedFirst<T>(authedPath: string, publicPath: string, isAuthed?: boolean | null): Promise<T> {
  if (isAuthed === false) {
    return apiGet<T>(publicPath);
  }
  try {
    return await apiGet<T>(authedPath);
  } catch {
    return apiGet<T>(publicPath);
  }
}

export async function listReleases(owner: string, repo: string, opts?: { isAuthed?: boolean | null }): Promise<Release[]> {
  const data = await tryAuthedFirst<{ releases?: Release[] }>(
    `${authedBase(owner, repo)}/releases`,
    `${publicBase(owner, repo)}/releases`,
    opts?.isAuthed,
  );
  return data.releases ?? [];
}

export async function getRelease(
  owner: string,
  repo: string,
  tag: string,
): Promise<{ release: Release; assets: ReleaseAsset[] }> {
  try {
    return await apiGet<{ release: Release; assets: ReleaseAsset[] }>(
      `${authedBase(owner, repo)}/releases/${encodeURIComponent(tag)}`,
    );
  } catch {
    return apiGet<{ release: Release; assets: ReleaseAsset[] }>(`${publicBase(owner, repo)}/releases/${encodeURIComponent(tag)}`);
  }
}

export async function createRelease(
  owner: string,
  repo: string,
  input: { tagName: string; name?: string; body?: string; isDraft?: boolean; isPrerelease?: boolean },
): Promise<{ release: Release }> {
  return apiPost<{ release: Release }>(`${authedBase(owner, repo)}/releases`, input);
}

export async function updateRelease(
  owner: string,
  repo: string,
  tag: string,
  input: { name?: string; body?: string; isDraft?: boolean; isPrerelease?: boolean },
): Promise<{ release: Release }> {
  return apiPatch<{ release: Release }>(`${authedBase(owner, repo)}/releases/${encodeURIComponent(tag)}`, input);
}

export async function deleteRelease(owner: string, repo: string, tag: string): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`${authedBase(owner, repo)}/releases/${encodeURIComponent(tag)}`);
}

export async function listReleaseAssets(owner: string, repo: string, tag: string): Promise<ReleaseAsset[]> {
  try {
    const data = await apiGet<{ assets?: ReleaseAsset[] }>(`${authedBase(owner, repo)}/releases/${encodeURIComponent(tag)}/assets`);
    return data.assets ?? [];
  } catch {
    const data = await apiGet<{ assets?: ReleaseAsset[] }>(`${publicBase(owner, repo)}/releases/${encodeURIComponent(tag)}/assets`);
    return data.assets ?? [];
  }
}

function encodeFileToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function uploadReleaseAsset(
  owner: string,
  repo: string,
  tag: string,
  file: File,
): Promise<{ asset: ReleaseAsset }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return apiPost<{ asset: ReleaseAsset }>(`${authedBase(owner, repo)}/releases/${encodeURIComponent(tag)}/assets`, {
    name: file.name,
    contentBase64: encodeFileToBase64(bytes),
    contentType: file.type || 'application/octet-stream',
  });
}

export function releaseAssetDownloadUrl(owner: string, repo: string, tag: string, assetId: string, authed: boolean): string {
  const base = authed ? authedBase(owner, repo) : publicBase(owner, repo);
  return `${base}/releases/${encodeURIComponent(tag)}/assets/${encodeURIComponent(assetId)}/download`;
}

export async function deleteReleaseAsset(owner: string, repo: string, tag: string, assetId: string): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`${authedBase(owner, repo)}/releases/${encodeURIComponent(tag)}/assets/${encodeURIComponent(assetId)}`);
}
