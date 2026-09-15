import { EdgeGitWorker } from './workers/EdgeGitWorker';

const worker = new EdgeGitWorker();

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => worker.fetch(request, env, ctx),
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => worker.scheduled(event, env, ctx),
};

export { CronTasksWorker, RepoWorker } from '@edge-git/background';
