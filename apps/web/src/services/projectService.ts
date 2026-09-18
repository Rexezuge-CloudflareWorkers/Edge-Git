import type { Project, ProjectBoard, ProjectCard, ProjectColumn } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';

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

export async function listProjects(owner: string, repo: string, opts?: { isAuthed?: boolean | null }): Promise<Project[]> {
  const data = await tryAuthedFirst<{ projects?: Project[] }>(
    `${authedBase(owner, repo)}/projects`,
    `${publicBase(owner, repo)}/projects`,
    opts?.isAuthed,
  );
  return data.projects ?? [];
}

export async function loadProjectBoard(
  owner: string,
  repo: string,
  number: number,
  opts?: { isAuthed?: boolean | null },
): Promise<ProjectBoard> {
  return tryAuthedFirst<ProjectBoard>(
    `${authedBase(owner, repo)}/projects/${number}`,
    `${publicBase(owner, repo)}/projects/${number}`,
    opts?.isAuthed,
  );
}

export async function createProject(
  owner: string,
  repo: string,
  input: { title: string; description?: string | null },
): Promise<{ project: Project }> {
  return apiPost(`${authedBase(owner, repo)}/projects`, input);
}

export async function updateProject(
  owner: string,
  repo: string,
  number: number,
  patch: { title?: string; description?: string | null; status?: 'open' | 'closed' },
): Promise<{ project: Project }> {
  return apiPatch(`${authedBase(owner, repo)}/projects/${number}`, patch);
}

export async function deleteProject(owner: string, repo: string, number: number): Promise<{ ok: boolean }> {
  return apiDelete(`${authedBase(owner, repo)}/projects/${number}`);
}

export async function createColumn(owner: string, repo: string, number: number, title: string): Promise<{ column: ProjectColumn }> {
  return apiPost(`${authedBase(owner, repo)}/projects/${number}/columns`, { title });
}

export async function renameColumn(
  owner: string,
  repo: string,
  number: number,
  columnId: string,
  title: string,
): Promise<{ column: ProjectColumn }> {
  return apiPatch(`${authedBase(owner, repo)}/projects/${number}/columns/${encodeURIComponent(columnId)}`, { title });
}

export async function deleteColumn(owner: string, repo: string, number: number, columnId: string): Promise<{ ok: boolean }> {
  return apiDelete(`${authedBase(owner, repo)}/projects/${number}/columns/${encodeURIComponent(columnId)}`);
}

export async function createCard(
  owner: string,
  repo: string,
  number: number,
  input: {
    columnId: string;
    kind?: 'note' | 'issue' | 'pull';
    noteTitle?: string;
    noteBody?: string;
    issueId?: string;
    pullRequestId?: string;
  },
): Promise<{ card: ProjectCard }> {
  return apiPost(`${authedBase(owner, repo)}/projects/${number}/cards`, input);
}

export async function moveCard(
  owner: string,
  repo: string,
  number: number,
  cardId: string,
  input: { toColumnId: string; position?: number },
): Promise<{ card: ProjectCard }> {
  return apiPatch(`${authedBase(owner, repo)}/projects/${number}/cards/${encodeURIComponent(cardId)}/move`, input);
}

export async function setCardArchived(
  owner: string,
  repo: string,
  number: number,
  cardId: string,
  archived: boolean,
): Promise<{ card: ProjectCard }> {
  return apiPatch(`${authedBase(owner, repo)}/projects/${number}/cards/${encodeURIComponent(cardId)}`, { archived });
}

export async function deleteCard(owner: string, repo: string, number: number, cardId: string): Promise<{ ok: boolean }> {
  return apiDelete(`${authedBase(owner, repo)}/projects/${number}/cards/${encodeURIComponent(cardId)}`);
}
