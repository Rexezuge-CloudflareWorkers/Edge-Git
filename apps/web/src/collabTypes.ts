// Collaboration-surfaces + social fan-out types, split out of `types.ts`
// to stay under the god-file guard (re-exported, so `../types` imports keep working).
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
  | 'fork_created'
  | 'release_created'
  | 'release_published'
  | 'project_created'
  | 'project_closed'
  | 'project_reopened'
  | 'discussion_opened'
  | 'discussion_answered'
  | 'discussion_locked'
  | 'discussion_commented'
  | 'wiki_created'
  | 'wiki_updated'
  | 'snippet_created';

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

export interface RepoWebhook {
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

export interface WebhookDelivery {
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

export interface Project {
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

export interface ProjectColumn {
  id: string;
  projectId: string;
  title: string;
  position: number;
  createdAt: number;
}

export interface ProjectCard {
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

export interface ProjectBoard {
  project: Project;
  columns: ProjectColumn[];
  cards: ProjectCard[];
}

export interface DiscussionCategory {
  id: string;
  repositoryId: string;
  slug: string;
  title: string;
  description: string | null;
  kind: 'general' | 'qa' | 'announcement' | 'ideas';
  createdAt: number;
}

export interface Discussion {
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

export interface DiscussionComment {
  id: string;
  discussionId: string;
  authorEmail: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface WikiPage {
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

export interface WikiRevision {
  id: string;
  pageId: string;
  revision: number;
  body: string;
  authorEmail: string;
  createdAt: number;
}

export interface Snippet {
  id: string;
  ownerEmail: string;
  title: string;
  visibility: 'public' | 'secret';
  createdAt: number;
  updatedAt: number;
}

export interface SnippetFile {
  id: string;
  snippetId: string;
  filename: string;
  body: string;
  createdAt: number;
}
