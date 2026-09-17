import { registerCollabBlamePublicRoutes, registerCollabBlameUserRoutes } from './collab/BlameRoutes';
import { registerCollabForkSyncRoutes } from './collab/ForkSyncRoutes';
import { registerCollabIssueTriageRoutes } from './collab/IssueTriageRoutes';
import { registerCollabLabelPublicRoutes, registerCollabLabelUserRoutes } from './collab/LabelRoutes';
import { registerCollabMilestonePublicRoutes, registerCollabMilestoneUserRoutes } from './collab/MilestoneRoutes';
import { registerCollabPullTriageRoutes } from './collab/PullTriageRoutes';
import type { CollabApp } from './collab/CollabHelpers';

function registerCollabPublicRoutes(app: CollabApp): void {
  registerCollabLabelPublicRoutes(app);
  registerCollabMilestonePublicRoutes(app);
  registerCollabBlamePublicRoutes(app);
}

function registerCollabUserRoutes(app: CollabApp): void {
  registerCollabLabelUserRoutes(app);
  registerCollabMilestoneUserRoutes(app);
  registerCollabIssueTriageRoutes(app);
  registerCollabPullTriageRoutes(app);
  registerCollabForkSyncRoutes(app);
  registerCollabBlameUserRoutes(app);
}

export { registerCollabPublicRoutes, registerCollabUserRoutes };
export type { CollabApp } from './collab/CollabHelpers';
