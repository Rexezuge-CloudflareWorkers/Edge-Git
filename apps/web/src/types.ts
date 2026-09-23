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
  // Social read-model (present on repo payloads so the code tab can seed
  // star/watch buttons without separate round-trips; absent on older
  // backends or list payloads that predate the enrichment).
  starsCount?: number;
  watchersCount?: number;
  viewerStarred?: boolean;
  viewerWatching?: boolean;
  starred?: boolean;
  watching?: boolean;
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

export interface Team {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TeamMember {
  email: string;
  username: string | null;
  role: 'admin' | 'member';
}

export interface TeamRepoGrant {
  repoId: string;
  fullName: string | null;
  role: 'admin' | 'write' | 'read';
}

export interface AuditLogEntry {
  id: string;
  timestamp: number;
  username: string;
  action: string;
  resource: string | null;
  method: string;
  path: string;
  statusCode: number;
  detail: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

// Git read-model + pull-request view models live in dedicated modules so
// `types.ts` stays a thin facade (Otter package-separation pattern).
// Re-exported here so existing `from '../../types'` imports keep working.
export type {
  BranchesResponse,
  TagInfo,
  TreeEntry,
  GitCommitAuthor,
  GitCommit,
  BlobResponse,
  OverviewReadme,
  OverviewResponse,
  FileCommitResult,
  DiffLine,
  DiffHunk,
  FileDiff,
  CommitDiffResult,
  CompareResult,
} from './repoTypes';
export type {
  PullRequest,
  PullReview,
  PullComment,
  PullThreadComment,
  PullReviewThread,
  PullDiffChange,
  PullDiff,
  MergePreview,
} from './pullTypes';

export interface Issue {
  id: string;
  repository_id: string;
  full_name: string;
  number: number;
  title: string;
  body: string | null;
  status: string;
  creator: string;
  created_at: number;
  updated_at: number;
}

export interface Comment {
  id: string;
  issue_id: string;
  author: string;
  body: string;
  created_at: number;
}

export type { TokenScope } from './transferTypes';
export type {
  TokenRepoGrant,
  RotatedToken,
  RepoGrantInput,
  RepoImportStatus,
  RepoImportJob,
  RepoMirror,
  RepoExport,
  DeployKeyPermission,
  DeployKey,
  CreatedDeployKey,
  SecretScanMode,
  RepoSecuritySettings,
} from './transferTypes';
import type { TokenRepoGrant, TokenScope } from './transferTypes';

export interface TokenMetadata {
  tokenId: string;
  name: string;
  expiresAt: number;
  lastUsedAt: number | null;
  createdAt: number;
  scopes: TokenScope[];
  tokenPrefix?: string | null;
  repoGrants?: TokenRepoGrant[];
}

export interface CreatedToken {
  tokenId: string;
  token: string;
  name: string;
  expiresAt: number;
  scopes: TokenScope[];
  prefix?: string;
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

export type CheckRunStatus = 'queued' | 'in_progress' | 'completed';

export type CheckConclusion = 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';

export interface CheckRun {
  id: string;
  headSha: string;
  context: string;
  status: CheckRunStatus;
  conclusion: CheckConclusion | null;
  detailsUrl: string | null;
  outputTitle: string | null;
  outputSummary: string | null;
  creatorEmail: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export * from './collabTypes';
