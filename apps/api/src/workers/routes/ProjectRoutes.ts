import { registerProjectUserReadRoutes } from './ProjectReadRoutes';
import { registerProjectUserWriteRoutes } from './ProjectWriteRoutes';
import type { ProjectApp } from './ProjectRouteParsers';

export { registerProjectPublicRoutes } from './ProjectReadRoutes';
export { parseProjectNumber } from './ProjectRouteParsers';

// Facade (Otter `PullUserRoutes` pattern): read routes live in
// `ProjectReadRoutes`, mutations in `ProjectWriteRoutes`. This module keeps
// the original `registerProjectPublicRoutes/registerProjectUserRoutes`
// surface so `EdgeGitWorker` and route tests are untouched.
function registerProjectUserRoutes(app: ProjectApp): void {
  registerProjectUserReadRoutes(app);
  registerProjectUserWriteRoutes(app);
}

export { registerProjectUserRoutes };
