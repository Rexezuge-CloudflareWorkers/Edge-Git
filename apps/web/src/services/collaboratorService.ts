import type { Collaborator } from '../types';
import { apiDelete, apiGet } from '../lib/api';

function collabBase(owner: string, repo: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators`;
}

export async function listCollaborators(owner: string, repo: string): Promise<Collaborator[]> {
  const data = await apiGet<{ collaborators?: Collaborator[] }>(collabBase(owner, repo));
  return data.collaborators ?? [];
}

export async function upsertCollaborator(
  owner: string,
  repo: string,
  member: string,
  role: 'admin' | 'write' | 'read',
): Promise<{ ok: boolean }> {
  const res = await fetch(`${collabBase(owner, repo)}/${encodeURIComponent(member)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

export async function removeCollaborator(owner: string, repo: string, member: string): Promise<{ ok: boolean }> {
  return apiDelete(`${collabBase(owner, repo)}/${encodeURIComponent(member)}`);
}
