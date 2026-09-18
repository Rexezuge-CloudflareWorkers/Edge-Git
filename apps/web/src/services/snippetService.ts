import type { Snippet, SnippetFile } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';

export interface SnippetDetail {
  snippet: Snippet;
  files: SnippetFile[];
}

export async function listMySnippets(): Promise<Snippet[]> {
  const data = await apiGet<{ snippets?: Snippet[] }>('/user/snippets');
  return data.snippets ?? [];
}

export async function listPublicSnippets(limit = 20): Promise<Snippet[]> {
  const data = await apiGet<{ snippets?: Snippet[] }>('/snippets/public', { limit: String(limit) });
  return data.snippets ?? [];
}

export async function listUserSnippets(username: string): Promise<Snippet[]> {
  const data = await apiGet<{ snippets?: Snippet[] }>(`/users/${encodeURIComponent(username)}/snippets`);
  return data.snippets ?? [];
}

export async function loadSnippet(id: string): Promise<SnippetDetail> {
  return apiGet<SnippetDetail>(`/snippets/${encodeURIComponent(id)}`);
}

export async function createSnippet(input: {
  title?: string;
  visibility?: 'public' | 'secret';
  files: Array<{ filename: string; body: string }>;
}): Promise<SnippetDetail> {
  return apiPost<SnippetDetail>('/user/snippets', input);
}

export async function updateSnippet(
  id: string,
  patch: { title?: string; visibility?: 'public' | 'secret'; files?: Array<{ filename: string; body: string }> },
): Promise<SnippetDetail> {
  return apiPatch<SnippetDetail>(`/user/snippets/${encodeURIComponent(id)}`, patch);
}

export async function deleteSnippet(id: string): Promise<{ ok: boolean }> {
  return apiDelete(`/user/snippets/${encodeURIComponent(id)}`);
}
