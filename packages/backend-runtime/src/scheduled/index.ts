/**
 * The scheduled-task Template Method — the kit's (`@rexezuge/runtime`).
 *
 * Re-exported here so the background worker has one import path for the kit's
 * worker bases, the same way `./base` carries the entrypoint/queue/workflow
 * shells.
 */
export { AbstractScheduledTask, TaskRegistry } from '@rexezuge/runtime';
export type {
  ApplicationRunHandle,
  ScheduledTaskEnv,
  TaskLogger,
  TaskRunRecorder,
  TaskRunSummary,
} from '@rexezuge/runtime';
