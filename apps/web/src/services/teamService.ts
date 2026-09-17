import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../lib/api';
import type { AuditLogEntry, Team, TeamMember, TeamRepoGrant } from '../types';

export async function listTeams(org: string): Promise<Team[]> {
  const data = await apiGet<{ teams?: Team[] }>(`/user/orgs/${encodeURIComponent(org)}/teams`);
  return data.teams ?? [];
}

export async function createTeam(org: string, input: { slug: string; name?: string; description?: string | null }): Promise<Team> {
  return apiPost<Team>(`/user/orgs/${encodeURIComponent(org)}/teams`, input);
}

export async function renameTeam(
  org: string,
  team: string,
  patch: { slug?: string; name?: string; description?: string | null },
): Promise<Team> {
  return apiPatch<Team>(`/user/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}`, patch);
}

export async function deleteTeam(org: string, team: string): Promise<{ ok: boolean }> {
  return apiDelete(`/user/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}`);
}

export async function listTeamMembers(org: string, team: string): Promise<TeamMember[]> {
  const data = await apiGet<{ members?: TeamMember[] }>(`/user/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/members`);
  return data.members ?? [];
}

export async function addTeamMember(
  org: string,
  team: string,
  target: { username?: string; email?: string; role?: 'admin' | 'member' },
): Promise<{ ok: boolean }> {
  return apiPost(`/user/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/members`, target);
}

export async function setTeamMemberRole(org: string, team: string, member: string, role: 'admin' | 'member'): Promise<{ ok: boolean }> {
  return apiPatch(`/user/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/members/${encodeURIComponent(member)}`, {
    role,
  });
}

export async function removeTeamMember(org: string, team: string, member: string): Promise<{ ok: boolean }> {
  return apiDelete(`/user/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/members/${encodeURIComponent(member)}`);
}

export async function listTeamRepos(org: string, team: string): Promise<TeamRepoGrant[]> {
  const data = await apiGet<{ repos?: TeamRepoGrant[] }>(`/user/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/repos`);
  return data.repos ?? [];
}

export async function grantTeamRepo(
  org: string,
  team: string,
  owner: string,
  repo: string,
  role: 'admin' | 'write' | 'read',
): Promise<{ ok: boolean }> {
  return apiPut(
    `/user/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { role },
  );
}

export async function revokeTeamRepo(org: string, team: string, owner: string, repo: string): Promise<{ ok: boolean }> {
  return apiDelete(
    `/user/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  );
}

export async function loadOrgAudit(
  org: string,
  params: { userEmail?: string; action?: string; repo?: string; limit?: number; cursor?: string } = {},
): Promise<{ logs: AuditLogEntry[]; nextCursor: string | null }> {
  const query: Record<string, string | undefined> = {
    userEmail: params.userEmail || undefined,
    action: params.action || undefined,
    repo: params.repo || undefined,
    limit: params.limit === undefined ? undefined : String(params.limit),
    cursor: params.cursor,
  };
  const data = await apiGet<{ logs?: AuditLogEntry[]; nextCursor?: string | null }>(`/user/orgs/${encodeURIComponent(org)}/audit`, query);
  return { logs: data.logs ?? [], nextCursor: data.nextCursor ?? null };
}

export async function loadMyAudit(
  params: { action?: string; limit?: number; cursor?: string } = {},
): Promise<{ logs: AuditLogEntry[]; nextCursor: string | null }> {
  const query: Record<string, string | undefined> = {
    action: params.action || undefined,
    limit: params.limit === undefined ? undefined : String(params.limit),
    cursor: params.cursor,
  };
  const data = await apiGet<{ logs?: AuditLogEntry[]; nextCursor?: string | null }>('/user/audit', query);
  return { logs: data.logs ?? [], nextCursor: data.nextCursor ?? null };
}
