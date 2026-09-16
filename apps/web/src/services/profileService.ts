import type { OrgMember, OrgSummary, Repo, UserOrOrgProfile } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';

export async function loadProfile(username: string): Promise<UserOrOrgProfile> {
  return apiGet<UserOrOrgProfile>(`/users/${encodeURIComponent(username)}`);
}

export async function listProfileRepos(username: string, limit = 100): Promise<Repo[]> {
  const data = await apiGet<{ repos?: Repo[] }>(`/users/${encodeURIComponent(username)}/repos`, { limit: String(limit) });
  return data.repos ?? [];
}

export async function listProfileOrgs(username: string): Promise<OrgSummary[]> {
  const data = await apiGet<{ orgs?: OrgSummary[] }>(`/users/${encodeURIComponent(username)}/orgs`);
  return data.orgs ?? [];
}

export async function listMyOrgs(): Promise<OrgSummary[]> {
  const data = await apiGet<{ orgs?: Array<{ username: string; displayName: string | null }> }>('/user/orgs');
  return data.orgs ?? [];
}

export async function createOrg(input: { username: string; displayName?: string | null }): Promise<OrgSummary> {
  return apiPost<OrgSummary>('/user/orgs', input);
}

export async function loadOrgAuthed(org: string): Promise<{ username: string; displayName: string | null; members: OrgMember[] }> {
  return apiGet(`/user/orgs/${encodeURIComponent(org)}`);
}

export async function updateOrg(org: string, patch: { displayName?: string | null; username?: string }): Promise<OrgSummary> {
  return apiPatch<OrgSummary>(`/user/orgs/${encodeURIComponent(org)}`, patch);
}

export async function disbandOrg(org: string): Promise<{ ok: boolean }> {
  return apiDelete(`/user/orgs/${encodeURIComponent(org)}`);
}

export async function listOrgMembers(org: string): Promise<OrgMember[]> {
  const data = await apiGet<{ members?: OrgMember[] }>(`/user/orgs/${encodeURIComponent(org)}/members`);
  return data.members ?? [];
}

export async function inviteOrgMember(org: string, target: { username?: string; email?: string; role?: 'owner' | 'member' }): Promise<{ ok: boolean }> {
  return apiPost(`/user/orgs/${encodeURIComponent(org)}/members`, target);
}

export async function setOrgMemberRole(org: string, member: string, role: 'owner' | 'member'): Promise<{ ok: boolean }> {
  return apiPatch(`/user/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(member)}`, { role });
}

export async function removeOrgMember(org: string, member: string): Promise<{ ok: boolean }> {
  return apiDelete(`/user/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(member)}`);
}
