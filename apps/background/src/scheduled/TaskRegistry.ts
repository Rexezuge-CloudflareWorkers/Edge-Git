import { createLogger } from '@edge-git/backend-runtime/logger';
import type { ScheduledTask } from './IScheduledTask';
import { AuditLogCleanupTask } from './AuditLogCleanupTask';
import { CheckPruneTask } from './CheckPruneTask';
import { CheckStaleTask } from './CheckStaleTask';
import { ExpiredTokenPruningTask } from './ExpiredTokenPruningTask';
import { RepoVacuumTask } from './RepoVacuumTask';
import { SearchBackfillTask } from './SearchBackfillTask';
import { WebhookDeliveryTask } from './WebhookDeliveryTask';
import { ImportSweeperTask } from './ImportSweeperTask';
import { MirrorSyncTask } from './MirrorSyncTask';
import { BackgroundTaskRunPruningTask, SocialPruningTask } from './SocialPruningTasks';

const logger = createLogger('CronTasks');

interface TaskDefinition {
  name: string;
  phase: 1 | 2;
  make: () => ScheduledTask;
}

const CRON_TASK_FACTORIES: readonly TaskDefinition[] = [
  { name: 'ExpiredTokenPruningTask', phase: 1, make: () => new ExpiredTokenPruningTask() },
  { name: 'BackgroundTaskRunPruningTask', phase: 2, make: () => new BackgroundTaskRunPruningTask() },
  { name: 'SearchBackfillTask', phase: 2, make: () => new SearchBackfillTask() },
  { name: 'SocialPruningTask', phase: 2, make: () => new SocialPruningTask() },
  { name: 'AuditLogCleanupTask', phase: 2, make: () => new AuditLogCleanupTask() },
  { name: 'CheckStaleTask', phase: 2, make: () => new CheckStaleTask() },
  { name: 'CheckPruneTask', phase: 2, make: () => new CheckPruneTask() },
  { name: 'WebhookDeliveryTask', phase: 2, make: () => new WebhookDeliveryTask() },
  { name: 'ImportSweeperTask', phase: 2, make: () => new ImportSweeperTask() },
  { name: 'MirrorSyncTask', phase: 2, make: () => new MirrorSyncTask() },
  { name: 'RepoVacuumTask', phase: 2, make: () => new RepoVacuumTask() },
];

// Eager instances preserved for backwards compat (tests index `.run`/instanceof).
// New code should prefer `CRON_TASK_FACTORIES` + `tasksForPhase` so task
// construction stays lazy per tick (AWS/Otter `make:() =>` parity).
const CRON_TASK_DEFINITIONS: ScheduledTask[] = CRON_TASK_FACTORIES.map((d) => d.make());

function tasksForPhase(phase: 1 | 2): ScheduledTask[] {
  return CRON_TASK_FACTORIES.filter((d) => d.phase === phase).map((d) => d.make());
}

// The 4-hour code-search tick. Must match the second entry of
// `triggers.crons` in `apps/api/wrangler.template.jsonc`; fast tasks run on
// every tick, SearchBackfillTask only here. Keep the two in sync when the
// schedule changes.
const SEARCH_TICK_CRON = '7 */4 * * *';

function isSearchTick(cron: string): boolean {
  const normalized = (cron ?? '').trim();
  // Manual POST /run and unit tests pass no cron — run everything so a
  // manual trigger never silently skips work.
  if (!normalized) return true;
  return normalized === SEARCH_TICK_CRON;
}

async function runScheduledTasks(env: Env, cron: string, scheduledTime: number): Promise<void> {
  logger.info(`Running scheduled tasks for ${cron} at ${scheduledTime}`);
  const searchTick = isSearchTick(cron);
  if (!searchTick) logger.info('Skipping SearchBackfillTask (off search tick)');
  const phase1 = tasksForPhase(1);
  const phase2 = tasksForPhase(2).filter((t) => searchTick || t.name !== 'SearchBackfillTask');
  await Promise.all(phase1.map((t) => t.run(env).catch((error: unknown) => logger.error(`Task ${t.name} failed`, error))));
  await Promise.all(phase2.map((t) => t.run(env).catch((error: unknown) => logger.error(`Task ${t.name} failed`, error))));
}

export { CRON_TASK_DEFINITIONS, CRON_TASK_FACTORIES, tasksForPhase, runScheduledTasks, isSearchTick, SEARCH_TICK_CRON };
export { BackgroundTaskRunPruningTask, SocialPruningTask } from './SocialPruningTasks';
export { AuditLogCleanupTask } from './AuditLogCleanupTask';
export { CheckPruneTask } from './CheckPruneTask';
export { CheckStaleTask } from './CheckStaleTask';
export { ExpiredTokenPruningTask } from './ExpiredTokenPruningTask';
export { SearchBackfillTask } from './SearchBackfillTask';
export { WebhookDeliveryTask } from './WebhookDeliveryTask';
export { ImportSweeperTask } from './ImportSweeperTask';
export { MirrorSyncTask } from './MirrorSyncTask';
export { RepoVacuumTask } from './RepoVacuumTask';
export type { ScheduledTask } from './IScheduledTask';
