import type { Comment, Issue } from '../types';
import { apiGet, apiPatch, apiPost } from '../lib/api';

function authedBase(owner: string, repo: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
}

function publicBase(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
}

export interface ReadOpts {
  isAuthed?: boolean | null;
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

export async function listIssues(owner: string, repo: string, opts?: ReadOpts): Promise<Issue[]> {
  const data = await tryAuthedFirst<{ issues?: Issue[] }>(authedBase(owner, repo), publicBase(owner, repo), opts?.isAuthed);
  return data.issues ?? [];
}

export async function createIssue(
  owner: string,
  repo: string,
  input: { title: string; body?: string },
): Promise<{ id: string; number: number }> {
  return apiPost<{ id: string; number: number }>(authedBase(owner, repo), input);
}

function authedIssue(owner: string, repo: string, number: number): string {
  return `${authedBase(owner, repo)}/${encodeURIComponent(String(number))}`;
}

function publicIssue(owner: string, repo: string, number: number): string {
  return `${publicBase(owner, repo)}/${encodeURIComponent(String(number))}`;
}

function unwrapIssue(data: Issue | { issue?: Issue }): Issue {
  const nested = (data as { issue?: Issue }).issue;
  return nested ?? (data as Issue);
}

export async function getIssue(owner: string, repo: string, number: number, opts?: ReadOpts): Promise<Issue> {
  return unwrapIssue(await tryAuthedFirst<Issue | { issue?: Issue }>(authedIssue(owner, repo, number), publicIssue(owner, repo, number), opts?.isAuthed));
}

export async function listComments(owner: string, repo: string, number: number, opts?: ReadOpts): Promise<Comment[]> {
  const data = await tryAuthedFirst<{ comments?: Comment[] }>(
    `${authedIssue(owner, repo, number)}/comments`,
    `${publicIssue(owner, repo, number)}/comments`,
    opts?.isAuthed,
  );
  return data.comments ?? [];
}

export async function addComment(owner: string, repo: string, number: number, input: { body: string }): Promise<Comment> {
  const data = await apiPost<Comment | { comment?: Comment }>(`${authedIssue(owner, repo, number)}/comments`, input);
  const nested = (data as { comment?: Comment }).comment;
  return nested ?? (data as Comment);
}

export async function updateIssueStatus(owner: string, repo: string, number: number, status: 'open' | 'closed'): Promise<Issue> {
  return unwrapIssue(await apiPatch<Issue | { issue?: Issue }>(authedIssue(owner, repo, number), { status }));
}
