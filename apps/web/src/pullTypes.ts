/**
 * Pull-request view-model types (extracted from `types.ts` god-file).
 * `types.ts` re-exports everything here so existing imports keep working.
 */
export interface PullRequest {
  id: string;
  repository_id: string;
  full_name: string;
  number: number;
  title: string;
  body: string | null;
  status: string;
  base_branch: string;
  head_branch: string;
  head_repository_id?: string | null;
  head_full_name?: string | null;
  base_oid: string | null;
  head_oid: string | null;
  merge_base_oid: string | null;
  creator_email: string;
  merged_by: string | null;
  merged_at: number | null;
  created_at: number;
  updated_at: number;
  milestone_id?: string | null;
  is_draft?: number | null;
}

export interface PullReview {
  id: string;
  pull_request_id: string;
  author_email: string;
  state: 'approved' | 'changes_requested' | 'commented';
  body: string | null;
  commit_oid: string | null;
  created_at: number;
  dismissed?: number | null;
  dismissed_by?: string | null;
  dismissed_at?: number | null;
  dismiss_reason?: string | null;
}

export interface PullComment {
  id: string;
  pull_request_id: string;
  author_email: string;
  body: string;
  created_at: number;
}

export interface PullThreadComment {
  id: string;
  thread_id: string;
  author_email: string;
  body: string;
  created_at: number;
}

export interface PullReviewThread {
  id: string;
  pull_request_id: string;
  path: string;
  line: number | null;
  side: 'old' | 'new';
  commit_oid: string | null;
  status: 'open' | 'resolved';
  author_email: string;
  created_at: number;
  resolved_by: string | null;
  resolved_at: number | null;
  comments: PullThreadComment[];
}

export interface PullDiffChange {
  type: 'add' | 'modify' | 'remove';
  path: string;
}

export interface PullDiff {
  mergeBase: string | null;
  truncated: boolean;
  changes: PullDiffChange[];
}

export interface MergePreview {
  baseOid: string;
  headOid: string;
  mergeBase: string | null;
  alreadyMerged: boolean;
  canFastForward: boolean;
}
