import type { Repo } from '../types';

// Repo vocabulary: the management UI's simplified view of a Repo.
// `toRepoView` projects backend state for display; `fromRepoView` rebuilds
// backend state (e.g. for optimistic updates), with `overrides` filling
// backend-only fields.
//
// Currently export-only (no call sites wired yet): list views keep reading
// `Repo` directly until the first display slice adopts `RepoView`.

interface RepoView {
  repoId: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  visibility: 'private' | 'public';
  canManage: boolean;
}

function toRepoView(repo: Repo): RepoView {
  return {
    repoId: repo.id,
    owner: repo.owner,
    name: repo.name,
    fullName: repo.fullName,
    description: repo.description,
    visibility: repo.isPrivate ? 'private' : 'public',
    canManage: repo.viewerCanManage ?? false,
  };
}

function fromRepoView(view: RepoView, overrides?: Partial<Repo>): Repo {
  return {
    id: view.repoId,
    owner: view.owner,
    name: view.name,
    fullName: view.fullName,
    description: view.description,
    isPrivate: view.visibility === 'private',
    createdAt: 0,
    updatedAt: 0,
    viewerCanManage: view.canManage,
    ...overrides,
  };
}

export { fromRepoView, toRepoView };
export type { RepoView };
