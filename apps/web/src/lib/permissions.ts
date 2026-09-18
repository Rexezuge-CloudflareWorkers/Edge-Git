import type { Repo } from '../types';

type ViewerRole = 'admin' | 'write' | 'read' | null | undefined;

// Single `canWrite` selector — replaces scattered `role==='admin'||'write'` checks.
function canWrite(role: ViewerRole): boolean {
  return role === 'admin' || role === 'write';
}

function canWriteRepo(repo: Pick<Repo, 'viewerRole' | 'viewerCanManage'> | null | undefined): boolean {
  if (!repo) return false;
  if (typeof repo.viewerCanManage === 'boolean') return repo.viewerCanManage || canWrite(repo.viewerRole);
  return canWrite(repo.viewerRole);
}

export { canWrite, canWriteRepo };
export type { ViewerRole };
