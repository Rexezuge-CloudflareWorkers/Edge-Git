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
}

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
