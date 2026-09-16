import type { Comment, Issue } from '../types';
import { apiGet, apiPatch, apiPost } from '../lib/api';

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

export async function getIssue(owner: string, repo: string, number: number): Promise<Issue> {
  try {
    return unwrapIssue(await apiGet<Issue | { issue?: Issue }>(authedIssue(owner, repo, number)));
  } catch {
    return unwrapIssue(await apiGet<Issue | { issue?: Issue }>(publicIssue(owner, repo, number)));
  }
}

export async function listComments(owner: string, repo: string, number: number): Promise<Comment[]> {
  try {
    const data = await apiGet<{ comments?: Comment[] }>(`${authedIssue(owner, repo, number)}/comments`);
    return data.comments ?? [];
  } catch {
    const data = await apiGet<{ comments?: Comment[] }>(`${publicIssue(owner, repo, number)}/comments`);
    return data.comments ?? [];
  }
}

export async function addComment(owner: string, repo: string, number: number, input: { body: string }): Promise<Comment> {
  const data = await apiPost<Comment | { comment?: Comment }>(`${authedIssue(owner, repo, number)}/comments`, input);
  const nested = (data as { comment?: Comment }).comment;
  return nested ?? (data as Comment);
}

export async function updateIssueStatus(owner: string, repo: string, number: number, status: 'open' | 'closed'): Promise<Issue> {
  return unwrapIssue(await apiPatch<Issue | { issue?: Issue }>(authedIssue(owner, repo, number), { status }));
}
