// The scheduled-task Template Method — the kit's (`@rexezuge/runtime`'s
// `AbstractScheduledTask`), adapted to this repo's cron.
//
// The kit's base owns the try/catch, so a task cannot forget it, and it
// re-throws after recording: a cron Durable Object that catches the rejection
// is the only party that knows which invocation failed, and swallowing inside
// the task turned that invocation into a *success*. Two seams come with it and
// are the reason to take it rather than keep the local copy:
//
// - `describeFailure` — how a caught error becomes the `errorMessage` written
//   to a run record. The default is the error's own message, which is right
//   for a console log and wrong for anything a user reads back; this repo
//   routes it through its redactor.
// - `swallowErrors` — whether `handle` swallows a failure after recording it.
//   `false`, so a failed task throws at the platform once its run record says
//   why.
//
// What stays local: the *phase* registry (this repo's cron runs two phases in
// order, each internally parallel), the per-task `name`, and the shape of the
// work itself.
import { AbstractScheduledTask as KitAbstractScheduledTask } from '@edge-git/backend-runtime/scheduled';
import type { TaskLogger } from '@edge-git/backend-runtime/scheduled';
import { TimestampUtil } from '@edge-git/shared/utils';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { ErrorSanitizationUtil } from '@rexezuge/shared';

const logger = createLogger('CronTasks');

/**
 * Where a caught failure goes.
 *
 * The kit's default writes to `console.error` directly, which would put this
 * repo's failures on a different channel from every other line it logs — and
 * past the level the deployment configured. Kept at module scope because it
 * holds no per-task state: every task's failures go to the same channel.
 */
const taskLogger: TaskLogger = (level, message) => {
  if (level === 'warn') logger.warn(message);
  else logger.error(message);
};

interface ScheduledTask {
  name: string;
  phase: 1 | 2;
  run: (env: Env) => Promise<void>;
}

/**
 * The event and context the base's own signature names.
 *
 * Derived from `handle` rather than declared here: the two are the kit's, and
 * a local copy of a structural type the base passes is a copy that can drift
 * from the one it actually receives.
 */
type CronHandle = KitAbstractScheduledTask<Env>['handle'];
type CronEvent = Parameters<CronHandle>[0];
type CronContext = Parameters<CronHandle>[2];

/**
 * The event a manual run reports.
 *
 * The cron runs from the platform's trigger *and* from the Durable Object's
 * `POST /run`, and a manual run has no platform event to hand — so it reports
 * an empty one rather than a fabricated schedule.
 */
const MANUAL_EVENT: CronEvent = {
  cron: '',
  scheduledTime: 0,
  noRetry: () => {},
};

/**
 * The execution context a manual run reports: nothing to keep alive and
 * nothing to pass through, because a manual run *is* the whole invocation.
 */
const MANUAL_CONTEXT: CronContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
};

abstract class BaseScheduledTask extends KitAbstractScheduledTask<Env> implements ScheduledTask {
  public abstract readonly name: string;
  public abstract readonly phase: 1 | 2;

  public run(env: Env, event: CronEvent = MANUAL_EVENT): Promise<void> {
    return this.handle(event, env, MANUAL_CONTEXT);
  }

  /**
   * The task's work.
   *
   * Named apart from the kit's `handleScheduledTask` so the two are not
   * confused: the kit's takes the event and the context as well, and this
   * repo's tasks need neither.
   */
  protected abstract performTask(env: Env): Promise<void>;

  protected override async handleScheduledTask(_event: CronEvent, env: Env, _ctx: CronContext): Promise<void> {
    logger.info(`Running scheduled task ${this.name}`);
    await this.performTask(env);
  }

  /**
   * Where a caught failure goes.
   *
   * The shared channel, not the kit's default — see `taskLogger` above.
   */
  protected override logger(): TaskLogger {
    return taskLogger;
  }

  /**
   * How a caught error is described.
   *
   * Redacted, because a failure whose message carries a token, a bearer
   * header or a signed URL must not write credential material into a record
   * an operator reads back.
   */
  protected override describeFailure(error: unknown): string {
    return ErrorSanitizationUtil.sanitizeErrorForLogging(error);
  }
}

// Template Method for retention pruning (Otter `AbstractPruningTask` pattern):
// subclasses supply the retention window + the batched prune call; the base
// owns cutoff arithmetic, failure swallowing (a prune miss retries next tick),
// and count logging so the three prune tasks stop duplicating the shape.
abstract class AbstractPruningTask extends BaseScheduledTask {
  protected abstract getRetentionDays(env: Env): number;

  protected abstract pruneBatch(env: Env, cutoff: number, batchSize: number): Promise<number>;

  protected abstract getPrunedNoun(): string;

  protected getBatchSize(): number {
    return 500;
  }

  protected override async performTask(env: Env): Promise<void> {
    const cutoff = TimestampUtil.getCurrentUnixTimestampInSeconds() - this.getRetentionDays(env) * 86_400;
    const pruned = await this.pruneBatch(env, cutoff, this.getBatchSize()).catch(() => 0);
    if (pruned > 0) {
      logger.info(`Pruned ${pruned} ${this.getPrunedNoun()}`);
    }
  }
}

export { BaseScheduledTask, AbstractPruningTask };
export type { ScheduledTask };
