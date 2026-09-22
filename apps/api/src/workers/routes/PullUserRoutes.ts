import type { PullApp } from './PullShared';
import { registerUserPullReadRoutes } from './PullUserReadRoutes';
import { registerUserPullWriteRoutes } from './PullUserWriteRoutes';

// Facade split (god-file guard): read-model GETs live in
// `PullUserReadRoutes`, mutations in `PullUserWriteRoutes`. This module stays
// the single registration point for `EdgeGitWorker` and route tests.
function registerUserPullRoutes(app: PullApp): void {
  registerUserPullReadRoutes(app);
  registerUserPullWriteRoutes(app);
}

export { registerUserPullRoutes };
