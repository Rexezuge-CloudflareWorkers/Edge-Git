import type { TokenRepoGrantMetadata } from './transfer';

export interface RepositoryMetadata {
  id: string;
  ownerEmail: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  createdAt: number;
  updatedAt: number;
}

export type TokenScope = 'repo:read' | 'repo:write' | 'admin';

export interface UserAccessTokenMetadata {
  tokenId: string;
  userEmail: string;
  tokenHash: string;
  name: string;
  expiresAt: number;
  lastUsedAt: number | null;
  createdAt: number;
  scopes: TokenScope[];
  tokenPrefix: string | null;
  repoGrants?: TokenRepoGrantMetadata[];
}

export type { TokenRepoGrantMetadata } from './transfer';
export type {
  RepoImportStatus,
  RepoImportMetadata,
  RepoMirrorMetadata,
  DeployKeyPermission,
  DeployKeyMetadata,
  SecretScanMode,
  SecretFinding,
  RepoSecuritySettingsMetadata,
} from './transfer';

export interface BranchProtectionRuleMetadata {
  id: string;
  repositoryId: string;
  pattern: string;
  requirePr: boolean;
  requiredApprovals: number;
  blockForcePush: boolean;
  blockDeletion: boolean;
  /*
   * Stored-but-ignored in v1 (no CI yet); kept so payloads stay
   * forward-compatible.
   */
  requireStatusChecks: string[];
  createdBy: string;
  createdAt: number;
}

export interface IssueMetadata {
  id: string;
  repositoryId: string;
  fullName: string;
  number: number;
  title: string;
  body: string | null;
  status: 'open' | 'closed';
  creatorEmail: string;
  createdAt: number;
  updatedAt: number;
}

export interface CommentMetadata {
  id: string;
  issueId: string | null;
  authorEmail: string;
  body: string;
  createdAt: number;
}

export interface LabelMetadata {
  id: string;
  repositoryId: string;
  name: string;
  color: string;
  description: string | null;
  createdAt: number;
}

export interface MilestoneMetadata {
  id: string;
  repositoryId: string;
  title: string;
  description: string | null;
  dueOn: number | null;
  status: 'open' | 'closed';
  createdAt: number;
}

export interface PullReviewerMetadata {
  pullRequestId: string;
  userEmail: string;
  status: 'pending' | 'approved' | 'changes_requested';
  createdAt: number;
}

export interface ReleaseMetadata {
  id: string;
  repositoryId: string;
  tagName: string;
  name: string;
  body: string;
  isDraft: boolean;
  isPrerelease: boolean;
  createdBy: string;
  createdAt: number;
  publishedAt: number | null;
}

export interface ReleaseAssetMetadata {
  id: string;
  releaseId: string;
  repositoryId: string;
  name: string;
  size: number;
  contentType: string;
  sha256: string;
  createdBy: string;
  createdAt: number;
}

export type WebhookEventName =
  | 'push'
  | 'repository'
  | 'issues'
  | 'issue_comment'
  | 'pull_request'
  | 'pull_request_review'
  | 'fork'
  | 'star'
  | 'watch'
  | 'release'
  | 'project'
  | 'discussion'
  | 'discussion_comment'
  | 'wiki'
  | 'snippet'
  | 'ping';

export interface RepoWebhookMetadata {
  id: string;
  repositoryId: string;
  fullName: string;
  urlMasked: string;
  hasSecret: boolean;
  secretSuffix: string;
  events: WebhookEventName[];
  isActive: boolean;
  consecutiveFailures: number;
  lastDeliveryAt: number | null;
  lastDeliveryStatus: 'success' | 'failure' | null;
  creatorEmail: string;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookDeliveryMetadata {
  id: string;
  hookId: string;
  repositoryId: string;
  event: string;
  eventId: string | null;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  nextRetryAt: number;
  lastHttpStatus: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectMetadata {
  id: string;
  repositoryId: string;
  number: number;
  title: string;
  description: string | null;
  status: 'open' | 'closed';
  creatorEmail: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectColumnMetadata {
  id: string;
  projectId: string;
  title: string;
  position: number;
  createdAt: number;
}

export interface ProjectCardMetadata {
  id: string;
  projectId: string;
  columnId: string;
  kind: 'note' | 'issue' | 'pull';
  noteTitle: string | null;
  noteBody: string | null;
  issueId: string | null;
  pullRequestId: string | null;
  position: number;
  archived: boolean;
  creatorEmail: string;
  createdAt: number;
  updatedAt: number;
}

export interface DiscussionCategoryMetadata {
  id: string;
  repositoryId: string;
  slug: string;
  title: string;
  description: string | null;
  kind: 'general' | 'qa' | 'announcement' | 'ideas';
  createdAt: number;
}

export interface DiscussionMetadata {
  id: string;
  repositoryId: string;
  categoryId: string | null;
  number: number;
  title: string;
  body: string | null;
  authorEmail: string;
  status: 'open' | 'locked' | 'answered';
  createdAt: number;
  updatedAt: number;
}

export interface DiscussionCommentMetadata {
  id: string;
  discussionId: string;
  authorEmail: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface WikiPageMetadata {
  id: string;
  repositoryId: string;
  slug: string;
  title: string;
  body: string;
  revision: number;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface WikiRevisionMetadata {
  id: string;
  pageId: string;
  revision: number;
  body: string;
  authorEmail: string;
  createdAt: number;
}

export interface SnippetMetadata {
  id: string;
  ownerEmail: string;
  title: string;
  visibility: 'public' | 'secret';
  createdAt: number;
  updatedAt: number;
}

export interface SnippetFileMetadata {
  id: string;
  snippetId: string;
  filename: string;
  body: string;
  createdAt: number;
}
