export interface CurrentUser {
  email: string;
  username?: string | null;
  /**
   * Preferred UI language (BCP 47 tag). Optional: persisted locally only
   * (`localStorage > navigator > en`).
   */
  preferredLanguage?: string | null;
}

export interface Repo {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  forkedFrom?: string | null;
  forksCount?: number;
  createdAt: number;
  updatedAt: number;
  viewerCanManage?: boolean;
  viewerRole?: 'admin' | 'write' | 'read' | null;
}

export type ProfileType = 'user' | 'org';

export interface UserOrOrgProfile {
  type: ProfileType;
  username: string;
  repoCount?: number | null;
  orgCount?: number | null;
  memberCount?: number | null;
  viewerIsSelf?: boolean;
  viewerIsMember?: boolean;
  viewerIsOwner?: boolean;
}

export interface OrgSummary {
  username: string;
}

export interface OrgMember {
  email: string;
  username: string | null;
  role: 'owner' | 'member';
}

export interface Collaborator {
  email: string;
  role: 'admin' | 'write' | 'read';
}

export interface BranchesResponse {
  branches: string[];
  currentBranch: string | null;
}

export interface TagInfo {
  name: string;
  ref: string;
  oid: string;
  peeledOid: string | null;
  type: 'lightweight' | 'annotated';
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  oid: string;
  lastCommit: GitCommit | null;
}

export interface GitCommitAuthor {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: number;
}

export interface GitCommit {
  oid: string;
  commit: {
    message: string;
    author: GitCommitAuthor;
    committer: GitCommitAuthor;
    parent: string[];
    tree: string;
  };
  payload: string;
}

export interface BlobResponse {
  oid: string;
  size: number;
  isBinary: boolean;
  contentBase64?: string;
}

export interface OverviewReadme extends BlobResponse {
  path: string;
  truncated?: boolean;
}

export interface OverviewResponse {
  branches: string[];
  currentBranch: string | null;
  resolvedRef: string | null;
  tags: TagInfo[];
  tree: TreeEntry[];
  commits: GitCommit[];
  readme: OverviewReadme | null;
}

export interface FileCommitResult {
  ok: boolean;
  commitOid: string;
  branch?: string;
  path?: string;
  created?: boolean;
  deleted?: boolean;
}

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  type: 'add' | 'modify' | 'remove';
  binary: boolean;
  tooLarge: boolean;
  hunks: DiffHunk[];
}

export interface CommitDiffResult {
  commit: GitCommit | null;
  truncated: boolean;
  files: FileDiff[];
}

export interface CompareResult {
  baseOid: string;
  headOid: string;
  mergeBase: string | null;
  truncated: boolean;
  files: FileDiff[];
}

export interface Issue {
  id: string;
  repository_id: string;
  full_name: string;
  number: number;
  title: string;
  body: string | null;
  status: string;
  creator_email: string;
  created_at: number;
  updated_at: number;
}

export interface Comment {
  id: string;
  issue_id: string;
  author_email: string;
  body: string;
  created_at: number;
}

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

export type TokenScope = 'repo:read' | 'repo:write' | 'admin';

export interface TokenMetadata {
  tokenId: string;
  name: string;
  expiresAt: number;
  lastUsedAt: number | null;
  createdAt: number;
  scopes: TokenScope[];
}

export interface CreatedToken {
  tokenId: string;
  token: string;
  name: string;
  expiresAt: number;
  scopes: TokenScope[];
}

export interface BranchProtectionRule {
  id: string;
  repositoryId: string;
  pattern: string;
  requirePr: boolean;
  requiredApprovals: number;
  blockForcePush: boolean;
  blockDeletion: boolean;
  requireStatusChecks: string[];
  createdBy: string;
  createdAt: number;
}

export type RepoEventType =
  | 'repo_created'
  | 'push'
  | 'issue_opened'
  | 'issue_closed'
  | 'issue_reopened'
  | 'issue_commented'
  | 'pr_opened'
  | 'pr_closed'
  | 'pr_merged'
  | 'pr_reviewed'
  | 'pr_commented'
  | 'fork_created';

export interface RepoEvent {
  id: string;
  repository_id: string;
  full_name: string;
  actor_email: string;
  type: RepoEventType;
  subject_type: string | null;
  subject_number: number | null;
  subject_oid: string | null;
  payload: string;
  created_at: number;
}

export interface NotificationItem {
  id: string;
  user_email: string;
  repository_id: string | null;
  full_name: string;
  actor_email: string;
  type: string;
  title: string;
  subject_type: string | null;
  subject_number: number | null;
  is_read: number;
  created_at: number;
}
