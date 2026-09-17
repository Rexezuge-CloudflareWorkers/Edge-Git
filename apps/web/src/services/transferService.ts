import type { RepoExport, RepoImportJob, RepoMirror } from '../types';
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api';

function transferPath(owner: string, repo: string, suffix: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

export async function startImport(owner: string, repo: string, sourceUrl: string): Promise<RepoImportJob> {
  const data = await apiPost<{ job: RepoImportJob }>(transferPath(owner, repo, '/import'), { sourceUrl }, 'POST');
  return data.job;
}

export async function getImport(owner: string, repo: string): Promise<RepoImportJob> {
  const data = await apiGet<{ job: RepoImportJob }>(transferPath(owner, repo, '/import'));
  return data.job;
}

export async function cancelImport(owner: string, repo: string, jobId: string): Promise<RepoImportJob> {
  const data = await apiPost<{ job: RepoImportJob }>(transferPath(owner, repo, `/import/${encodeURIComponent(jobId)}/cancel`));
  return data.job;
}

export async function exportRepo(owner: string, repo: string): Promise<RepoExport> {
  return apiGet<RepoExport>(transferPath(owner, repo, '/export'));
}

export async function getMirror(owner: string, repo: string): Promise<RepoMirror | null> {
  try {
    const data = await apiGet<{ mirror: RepoMirror }>(transferPath(owner, repo, '/mirror'));
    return data.mirror;
  } catch {
    return null;
  }
}

export async function putMirror(owner: string, repo: string, sourceUrl: string, intervalMinutes: number): Promise<RepoMirror> {
  const data = await apiPut<{ mirror: RepoMirror }>(transferPath(owner, repo, '/mirror'), { sourceUrl, intervalMinutes });
  return data.mirror;
}

export async function syncMirror(owner: string, repo: string): Promise<RepoMirror> {
  const data = await apiPost<{ mirror: RepoMirror }>(transferPath(owner, repo, '/mirror/sync'));
  return data.mirror;
}

export async function setMirrorEnabled(owner: string, repo: string, enabled: boolean): Promise<RepoMirror> {
  const data = await apiPost<{ mirror: RepoMirror }>(transferPath(owner, repo, '/mirror/enable'), { enabled });
  return data.mirror;
}

export async function deleteMirror(owner: string, repo: string): Promise<void> {
  await apiDelete<{ ok: boolean }>(transferPath(owner, repo, '/mirror'));
}
