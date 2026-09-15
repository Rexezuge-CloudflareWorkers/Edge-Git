import { EdgeGitWorker } from './workers/EdgeGitWorker';
import { CronTasksWorker } from '@edge-git/background';
import { RepoWorker } from '@edge-git/background';

export { CronTasksWorker, RepoWorker };

const worker = new EdgeGitWorker();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => worker.fetch(request, env, ctx),
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => worker.scheduled(event, env, ctx),
};
