import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '../lib/api';
export interface Label {
  id: string;
  repository_id: string;
  name: string;
  color: string;
  description: string | null;
  created_at: number;
}

export interface Milestone {
  id: string;
  repository_id: string;
  title: string;
  description: string | null;
  due_on: number | null;
  status: string;
  created_at: number;
}

function base(owner: string, repo: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export async function listLabels(owner: string, repo: string): Promise<Label[]> {
  try {
    const data = await apiGet<{ labels?: Label[] }>(`${base(owner, repo)}/labels`);
    return data.labels ?? [];
  } catch {
    return [];
  }
}

export async function createLabel(
  owner: string,
  repo: string,
  input: { name: string; color?: string; description?: string },
): Promise<{ id: string }> {
  return apiPost<{ id: string }>(`${base(owner, repo)}/labels`, input);
}

export async function listMilestones(owner: string, repo: string): Promise<Milestone[]> {
  try {
    const data = await apiGet<{ milestones?: Milestone[] }>(`${base(owner, repo)}/milestones`);
    return data.milestones ?? [];
  } catch {
    return [];
  }
}

export async function getIssueMeta(owner: string, repo: string, number: number): Promise<{ labels: Label[]; assignees: string[] }> {
  try {
    const data = await apiGet<{ labels?: Label[]; assignees?: string[] }>(`${base(owner, repo)}/issues/${number}/meta`);
    return { labels: data.labels ?? [], assignees: data.assignees ?? [] };
  } catch {
    return { labels: [], assignees: [] };
  }
}

export async function setIssueLabels(owner: string, repo: string, number: number, labelIds: string[]): Promise<void> {
  await apiPut(`${base(owner, repo)}/issues/${number}/labels`, { labelIds });
}

export async function getPullMeta(
  owner: string,
  repo: string,
  number: number,
): Promise<{ labels: Label[]; assignees: string[]; reviewers: Array<{ user_email: string; status: string }> }> {
  try {
    const data = await apiGet<{ labels?: Label[]; assignees?: string[]; reviewers?: Array<{ user_email: string; status: string }> }>(
      `${base(owner, repo)}/pulls/${number}/meta`,
    );
    return { labels: data.labels ?? [], assignees: data.assignees ?? [], reviewers: data.reviewers ?? [] };
  } catch {
    return { labels: [], assignees: [], reviewers: [] };
  }
}

export async function requestReviewers(owner: string, repo: string, number: number, reviewers: string[]): Promise<void> {
  await apiPost(`${base(owner, repo)}/pulls/${number}/reviewers`, { reviewers });
}

export async function setPullDraft(owner: string, repo: string, number: number, isDraft: boolean): Promise<void> {
  await apiPatch(`${base(owner, repo)}/pulls/${number}/draft`, { isDraft });
}

export async function getCodeowners(owner: string, repo: string, number: number): Promise<{ owners: string[] }> {
  try {
    return await apiGet<{ owners: string[] }>(`${base(owner, repo)}/pulls/${number}/codeowners`);
  } catch {
    return { owners: [] };
  }
}

export async function previewSync(
  owner: string,
  repo: string,
  params: { upstreamOwner: string; upstreamRepo: string; upstreamBranch?: string; branch?: string },
): Promise<{ preview: { alreadyMerged: boolean; canFastForward: boolean } | null }> {
  const q = new URLSearchParams({
    upstreamOwner: params.upstreamOwner,
    upstreamRepo: params.upstreamRepo,
    upstreamBranch: params.upstreamBranch ?? 'main',
    branch: params.branch ?? 'main',
  });
  try {
    return await apiGet(`${base(owner, repo)}/sync-preview?${q.toString()}`);
  } catch {
    return { preview: null };
  }
}

export async function syncFork(
  owner: string,
  repo: string,
  input: { upstreamOwner: string; upstreamRepo: string; upstreamBranch?: string; branch?: string },
): Promise<unknown> {
  return apiPost(`${base(owner, repo)}/sync`, input);
}

export async function getBlame(
  owner: string,
  repo: string,
  path: string,
  ref?: string,
  isAuthed?: boolean | null,
): Promise<{ lines: Array<{ line: number; commitOid: string; author: string; content: string }> } | null> {
  const q = new URLSearchParams({ path, ...(ref && { ref }) });
  const authedPath = `${base(owner, repo)}/blame?${q.toString()}`;
  const publicPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blame?${q.toString()}`;
  try {
    if (isAuthed === false) {
      const data = await apiGet<{ blame?: { lines: Array<{ line: number; commitOid: string; author: string; content: string }> } }>(
        publicPath,
      );
      return data.blame ? { lines: data.blame.lines } : null;
    }
    try {
      const data = await apiGet<{ blame?: { lines: Array<{ line: number; commitOid: string; author: string; content: string }> } }>(
        authedPath,
      );
      return data.blame ? { lines: data.blame.lines } : null;
    } catch {
      const data = await apiGet<{ blame?: { lines: Array<{ line: number; commitOid: string; author: string; content: string }> } }>(
        publicPath,
      );
      return data.blame ? { lines: data.blame.lines } : null;
    }
  } catch {
    return null;
  }
}

export async function deleteLabel(owner: string, repo: string, id: string): Promise<void> {
  await apiDelete(`${base(owner, repo)}/labels/${encodeURIComponent(id)}`);
}
