import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { NotificationService } from '@edge-git/backend-services/social/NotificationService';
import type { IRealtimePublisher } from '@edge-git/backend-services/ports';
import { mapRepoEventToWebhookEvent } from '@edge-git/backend-services/webhook';
import type { WebhookEventName } from '@edge-git/shared';
import type { RepoEventType } from '@edge-git/backend-data/dao';
import type { RealtimeWorker } from '@edge-git/background';
import { getRealtimeStub } from '../doStubs';

interface SocialEmitInput {
  repositoryId: string;
  fullName: string;
  actorEmail: string;
  type: RepoEventType;
  title: string;
  subjectType?: string | null;
  subjectNumber?: number | null;
  subjectOid?: string | null;
  payload?: Record<string, unknown>;
  participantEmails?: string[];
  mentionText?: string | null;
}

// Best-effort activity + notification fan-out for issue/PR/fork/push flows.
// Never throws: social writes must not fail the user-visible mutation.
async function recordAndNotify(env: Env, input: SocialEmitInput): Promise<void> {
  const scope = createRequestScope(env);
  try {
    await scope.get(Tokens.ActivityService).record({
      repositoryId: input.repositoryId,
      fullName: input.fullName,
      actorEmail: input.actorEmail,
      type: input.type,
      subjectType: input.subjectType ?? null,
      subjectNumber: input.subjectNumber ?? null,
      subjectOid: input.subjectOid ?? null,
      payload: input.payload ?? {},
    });
  } catch (error) {
    console.error('Failed to record repo event', input.type, input.fullName, error);
  }
  try {
    const mentionUsernames = NotificationService.parseMentions(input.mentionText ?? input.title);
    const fanout = await scope
      .get(Tokens.NotificationService)
      .fanOut({
        repositoryId: input.repositoryId,
        fullName: input.fullName,
        actorEmail: input.actorEmail,
        type: input.type,
        title: input.title,
        subjectType: input.subjectType ?? null,
        subjectNumber: input.subjectNumber ?? null,
        participantEmails: input.participantEmails ?? [],
        mentionUsernames,
      })
      .catch(() => ({ notified: 0, recipients: [] as string[] }));
    await publishLiveUpdate(env, {
      fullName: input.fullName,
      channel: channelForRepoEvent(input.type, input.subjectType ?? null, input.subjectNumber ?? null),
      type: input.type,
      actorEmail: input.actorEmail,
      title: input.title,
      subjectType: input.subjectType ?? null,
      subjectNumber: input.subjectNumber ?? null,
      subjectOid: input.subjectOid ?? null,
      extra: input.payload ?? {},
      recipientEmails: fanout.recipients,
    });
  } catch (error) {
    console.error('Failed to fan out notifications', input.type, input.fullName, error);
  }
  try {
    await scope.get(Tokens.WatchService).ensureWatching(input.repositoryId, input.actorEmail);
  } catch {
    // auto-watch is a nicety; ignore
  }
  const webhookEvent = mapRepoEventToWebhookEvent(input.type);
  if (webhookEvent) {
    await emitWebhookEvent(env, {
      repositoryId: input.repositoryId,
      fullName: input.fullName,
      actorEmail: input.actorEmail,
      event: webhookEvent,
      eventId: null,
      subjectType: input.subjectType,
      subjectNumber: input.subjectNumber,
      subjectOid: input.subjectOid,
      title: input.title,
      extra: input.payload,
    });
  }
}

interface WebhookEmitInput {
  repositoryId: string;
  fullName: string;
  actorEmail: string;
  event: WebhookEventName;
  eventId?: string | null;
  subjectType?: string | null;
  subjectNumber?: number | null;
  subjectOid?: string | null;
  title?: string | null;
  action?: string | null;
  extra?: Record<string, unknown>;
}

// DO-stub transport behind the `IRealtimePublisher` port: the bus owns fan-out
// decisions, `apps/api` owns stub resolution (layer rule). The port message
// stays `Record<string, unknown>` so `backend-services` never imports the
// DO input type; the cast lives at this boundary only.
function realtimePort(env: Env): IRealtimePublisher {
  return {
    publishToShard: async (shard, message) => {
      await getRealtimeStub(env, shard).publish(message as unknown as Parameters<RealtimeWorker['publish']>[0]);
    },
  };
}

// Direct webhook fan-out for events without a repo_events row (star/watch).
// Best-effort: never throws.
async function emitWebhookEvent(env: Env, input: WebhookEmitInput): Promise<void> {
  try {
    await createRequestScope(env).get(Tokens.DomainEventBus).emit({ type: 'webhook.emit', input });
  } catch (error) {
    console.error('Failed to enqueue webhook deliveries', input.event, input.fullName, error);
  }
}

// Immediate dispatch for request-triggered flushes (waitUntil) and the cron
// sweeper's fallback. Never throws; concurrent flushers are safe via the
// optimistic per-row claim in the delivery service.
async function flushDueWebhookDeliveries(env: Env, limit = 50): Promise<{ processed: number; succeeded: number; failed: number }> {
  try {
    return await createRequestScope(env).get(Tokens.WebhookDeliveryService).processDue({ limit });
  } catch (error) {
    console.error('Failed to flush webhook deliveries', error);
    return { processed: 0, succeeded: 0, failed: 0 };
  }
}

// Subject-scoped channels drive the live detail views (`issue:12`, `pr:34`);
// everything else lands on `activity` for the repo feed.
function channelForRepoEvent(type: string, subjectType: string | null, subjectNumber: number | null): string {
  if (typeof subjectNumber === 'number' && Number.isSafeInteger(subjectNumber)) {
    if (subjectType === 'issue') return `issue:${subjectNumber}`;
    if (subjectType === 'pull') return `pr:${subjectNumber}`;
  }
  return 'activity';
}

interface LiveUpdateInput {
  fullName: string;
  channel: string;
  type: string;
  actorEmail: string;
  title: string;
  subjectType?: string | null;
  subjectNumber?: number | null;
  subjectOid?: string | null;
  extra?: Record<string, unknown>;
  recipientEmails?: string[];
}

// Best-effort live fan-out: one RPC to the repo shard plus (when D1 fan-out
// named recipients) one RPC to the global inbox shard. Never throws; no-ops
// when realtime is disabled or the binding is missing (tests/legacy env).
// Fan-out decisions live in the bus subscriber; this stays a thin emitter.
async function publishLiveUpdate(env: Env, input: LiveUpdateInput): Promise<void> {
  try {
    await createRequestScope(env)
      .get(Tokens.DomainEventBus)
      .emit({
        type: 'realtime.publish',
        input: {
          fullName: input.fullName,
          channel: input.channel,
          type: input.type,
          actorEmail: input.actorEmail,
          title: input.title,
          subjectType: input.subjectType,
          subjectNumber: input.subjectNumber,
          subjectOid: input.subjectOid,
          extra: input.extra,
          recipientEmails: input.recipientEmails,
        },
        via: realtimePort(env),
      });
  } catch {
    // binding missing or scope unavailable — live updates are a nicety
  }
}

// Commit status changes drive the live `PullChecks` badge via a per-SHA
// channel. Best-effort: never throws. Validation + channel mapping live in
// the bus subscriber; this stays a thin emitter.
async function publishCheckUpdate(
  env: Env,
  input: {
    fullName: string;
    headSha: string;
    context: string;
    status: string;
    conclusion?: string | null;
    actorEmail: string;
    checkId?: string;
    title?: string;
  },
): Promise<void> {
  try {
    await createRequestScope(env)
      .get(Tokens.DomainEventBus)
      .emit({
        type: 'check.updated',
        input: {
          fullName: input.fullName,
          headSha: input.headSha,
          context: input.context,
          status: input.status,
          conclusion: input.conclusion,
          actorEmail: input.actorEmail,
          checkId: input.checkId,
          title: input.title,
        },
        via: realtimePort(env),
      });
  } catch {
    // live updates are a nicety
  }
}

export { recordAndNotify, emitWebhookEvent, flushDueWebhookDeliveries, publishLiveUpdate, publishCheckUpdate, channelForRepoEvent };
export type { SocialEmitInput, WebhookEmitInput, LiveUpdateInput };
