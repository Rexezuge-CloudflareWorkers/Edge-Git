/**
 * Worker base classes — the kit's (`@rexezuge/runtime`).
 *
 * These are pure dispatch shells: one `fetch` entry each, error containment
 * inside it, and an execution context that forwards `waitUntil`. They are
 * byte-identical to this repo's former copies apart from two deliberate drops,
 * both of which the kit's convergence pass already decided on:
 *
 * - `AbstractDurableObjectWorker` extends the real `DurableObject` from
 *   `cloudflare:workers` and is generic in its env. The local copy existed only
 *   so this layer typechecked without the platform types, and nothing in
 *   production used it — `RepoWorker` extends the real base.
 * - `AbstractEntrypointWorker` carries no `/__scheduled` bypass. A cron trigger
 *   reaches an entrypoint through `scheduled()`, not through a magic path; the
 *   bypass meant any request to `GET /__scheduled` ran the whole cron body,
 *   which is a remote-triggerable task runner wearing a URL.
 */
export {
  AbstractDurableObjectWorker,
  AbstractEntrypointWorker,
  AbstractQueueWorker,
  AbstractWorkflowWorker,
} from '@rexezuge/runtime';
export type { WorkerExecutionContext, WorkerMessageBatch, WorkerScheduledController, WorkflowEventLike, WorkflowStepLike } from '@rexezuge/runtime';