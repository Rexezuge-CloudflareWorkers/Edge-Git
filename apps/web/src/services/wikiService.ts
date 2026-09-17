import type { WikiPage, WikiRevision } from '../types';
import { apiDelete, apiGet, apiPost } from '../lib/api';

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

export async function listWikiPages(owner: string, repo: string, q?: string, opts?: { isAuthed?: boolean | null }): Promise<WikiPage[]> {
  const suffix = q ? `?q=${encodeURIComponent(q)}` : '';
  const data = await tryAuthedFirst<{ pages?: WikiPage[] }>(`${authedBase(owner, repo)}/wiki${suffix}`, `${publicBase(owner, repo)}/wiki${suffix}`, opts?.isAuthed);
  return data.pages ?? [];
}

export async function loadWikiPage(owner: string, repo: string, slug: string, opts?: { isAuthed?: boolean | null }): Promise<{ page: WikiPage }> {
  return tryAuthedFirst(`${authedBase(owner, repo)}/wiki/${encodeURIComponent(slug)}`, `${publicBase(owner, repo)}/wiki/${encodeURIComponent(slug)}`, opts?.isAuthed);
}

export async function createWikiPage(owner: string, repo: string, input: { slug: string; title: string; body?: string }): Promise<{ page: WikiPage }> {
  return apiPost(`${authedBase(owner, repo)}/wiki`, input);
}

export async function updateWikiPage(
  owner: string,
  repo: string,
  slug: string,
  input: { title?: string; body?: string; expectedRevision?: number },
): Promise<{ page: WikiPage }> {
  const res = await fetch(`${authedBase(owner, repo)}/wiki/${encodeURIComponent(slug)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const error = await res.text();
    throw new Error(error || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function deleteWikiPage(owner: string, repo: string, slug: string): Promise<{ ok: boolean }> {
  return apiDelete(`${authedBase(owner, repo)}/wiki/${encodeURIComponent(slug)}`);
}

export async function loadWikiRevisions(owner: string, repo: string, slug: string): Promise<WikiRevision[]> {
  const data = await apiGet<{ revisions?: WikiRevision[] }>(`${authedBase(owner, repo)}/wiki/${encodeURIComponent(slug)}/revisions`);
  return data.revisions ?? [];
}

export async function saveWikiPage(owner: string, repo: string, input: { slug: string; title: string; body?: string }): Promise<{ page: WikiPage }> {
  return apiPost(`${authedBase(owner, repo)}/wiki`, input);
}
