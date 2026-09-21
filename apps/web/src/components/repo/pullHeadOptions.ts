import type { PullRequest, Repo } from '../../types';

export function headLabel(pull: PullRequest): string {
  return pull.head_full_name && pull.head_full_name.toLowerCase() !== pull.full_name.toLowerCase()
    ? `${pull.head_full_name}:${pull.head_branch}`
    : pull.head_branch;
}

export function sameRepoName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function mergeHeadRepoOptions(
  currentFull: string,
  parent: string | null | undefined,
  forks: Repo[],
  prev: string,
): { options: string[]; selected: string } {
  const options = [currentFull];
  if (parent && options.every((o) => !sameRepoName(o, parent))) {
    options.push(parent);
  }
  for (const f of forks) {
    if (options.every((o) => !sameRepoName(o, f.fullName))) options.push(f.fullName);
  }
  return { options, selected: options.some((o) => sameRepoName(o, prev)) ? prev : currentFull };
}
