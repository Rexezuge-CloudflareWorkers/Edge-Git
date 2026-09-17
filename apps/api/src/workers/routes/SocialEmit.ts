import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { NotificationService } from '@edge-git/backend-services/social/NotificationService';
import { mapRepoEventToWebhookEvent } from '@edge-git/backend-services/webhook';
import type { WebhookEventName } from '@edge-git/shared';
import type { RepoEventType } from '@edge-git/backend-data/dao';

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
    await scope.get(Tokens.NotificationService).fanOut({
      repositoryId: input.repositoryId,
      fullName: input.fullName,
      actorEmail: input.actorEmail,
      type: input.type,
      title: input.title,
      subjectType: input.subjectType ?? null,
      subjectNumber: input.subjectNumber ?? null,
      participantEmails: input.participantEmails ?? [],
      mentionUsernames,
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

// Direct webhook fan-out for events without a repo_events row (star/watch).
// Best-effort: never throws.
async function emitWebhookEvent(env: Env, input: WebhookEmitInput): Promise<void> {
  try {
    await createRequestScope(env)
      .get(Tokens.WebhookDeliveryService)
      .enqueueForEvent({
        repositoryId: input.repositoryId,
        fullName: input.fullName,
        event: input.event,
        actorEmail: input.actorEmail,
        eventId: input.eventId,
        subjectType: input.subjectType,
        subjectNumber: input.subjectNumber,
        subjectOid: input.subjectOid,
        title: input.title,
        action: input.action,
        extra: input.extra,
      });
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

export { recordAndNotify, emitWebhookEvent, flushDueWebhookDeliveries };
export type { SocialEmitInput, WebhookEmitInput };
