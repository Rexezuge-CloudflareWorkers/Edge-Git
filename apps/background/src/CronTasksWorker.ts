import { DurableObject } from 'cloudflare:workers';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { runScheduledTasks } from './scheduled/TaskRegistry';

const logger = createLogger('CronTasksWorker');

class CronTasksWorker extends DurableObject<Env> {
  private currentRun: Promise<void> | null = null;

  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/run' || request.method !== 'POST') {
      return new Response('Not Found', { status: 404 });
    }
    if (this.currentRun) {
      return new Response('Already running', { status: 202 });
    }
    const body = (await request.json().catch(() => ({}))) as { cron?: string; scheduledTime?: number };
    this.currentRun = runScheduledTasks(this.env, body.cron ?? '', body.scheduledTime ?? Date.now())
      .catch((error: unknown) => {
        logger.error('Cron run failed', error);
      })
      .finally(() => {
        this.currentRun = null;
      });
    // Single-flight without blocking: return 202 immediately and let the DO
    // keep running via waitUntil. Awaiting here would serialize cron ticks
    // behind the full phase1+phase2 run and risk DO fetch wall-time timeouts.
    const waitUntil = (this.ctx as unknown as { waitUntil?: (p: Promise<unknown>) => void }).waitUntil?.bind(this.ctx);
    if (typeof waitUntil === 'function') {
      waitUntil(this.currentRun);
    }
    return new Response('Started', { status: 202 });
  }
}

export { CronTasksWorker };
export type { Env };
