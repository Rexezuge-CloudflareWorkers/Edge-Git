import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { NotificationService } from '@edge-git/backend-services/social/NotificationService';
import { RealtimeService } from '@edge-git/backend-services/realtime';
import { mapRepoEventToWebhookEvent } from '@edge-git/backend-services/webhook';
import { INBOX_SHARD, isChannel, repoShardFor } from '@edge-git/shared/realtime';
import type { WebhookEventName } from '@edge-git/shared';
import type { RepoEventType } from '@edge-git/backend-data/dao';
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

// Direct webhook fan-out for events without a repo_events row (star/watch).
// Best-effort: never throws.
async function emitWebhookEvent(env: Env, input: WebhookEmitInput): Promise<void> {
  try {
    await createRequestScope(env).get(Tokens.WebhookDeliveryService).enqueueForEvent({
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
async function publishLiveUpdate(env: Env, input: LiveUpdateInput): Promise<void> {
  try {
    if (!createRequestScope(env).get(Tokens.AppConfig).isRealtimeEnabled()) return;
    if (!isChannel(input.channel)) return;
    const stub = getRealtimeStub(env, repoShardFor(input.fullName));
    await stub
      .publish({
        channel: input.channel,
        type: input.type,
        actor: input.actorEmail,
        title: input.title,
        subjectType: input.subjectType ?? null,
        subjectNumber: input.subjectNumber ?? null,
        sha: input.subjectOid ?? null,
        extra: input.extra ?? {},
      })
      .catch(() => undefined);
    const recipients = input.recipientEmails ?? [];
    if (recipients.length === 0) return;
    const hashes = await RealtimeService.hashRecipients(recipients).catch(() => [] as string[]);
    if (hashes.length === 0) return;
    const inbox = getRealtimeStub(env, INBOX_SHARD);
    await inbox
      .publish({
        channel: `inbox:${hashes[0]}`,
        type: input.type,
        actor: input.actorEmail,
        title: input.title,
        subjectType: input.subjectType ?? null,
        subjectNumber: input.subjectNumber ?? null,
        sha: input.subjectOid ?? null,
        extra: { ...input.extra, fullName: input.fullName },
        recipientHashes: hashes,
      })
      .catch(() => undefined);
  } catch {
    // binding missing or scope unavailable — live updates are a nicety
  }
}

// Commit status changes drive the live `PullChecks` badge via a per-SHA
// channel. Best-effort: never throws.
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
    if (!createRequestScope(env).get(Tokens.AppConfig).isRealtimeEnabled()) return;
    if (!/^[0-9a-f]{4,64}$/i.test(input.headSha)) return;
    const channel = `checks:${input.headSha.toLowerCase()}`;
    if (!isChannel(channel)) return;
    const stub = getRealtimeStub(env, repoShardFor(input.fullName));
    await stub
      .publish({
        channel,
        type: 'check_run.updated',
        actor: input.actorEmail,
        title: input.title ?? `${input.context}: ${input.conclusion ?? input.status}`,
        sha: input.headSha.toLowerCase(),
        extra: { check_run_id: input.checkId ?? null, context: input.context, status: input.status, conclusion: input.conclusion ?? null },
      })
      .catch(() => undefined);
  } catch {
    // live updates are a nicety
  }
}

export { recordAndNotify, emitWebhookEvent, flushDueWebhookDeliveries, publishLiveUpdate, publishCheckUpdate, channelForRepoEvent };
export type { SocialEmitInput, WebhookEmitInput, LiveUpdateInput };
