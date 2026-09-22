import type { RepoWebhookRow, WebhookDeliveryRow } from '@edge-git/backend-data/dao';
import type { WebhookDeliveryMetadata, WebhookEventName } from '@edge-git/shared';

/**
 * Pure delivery mapping policy for webhooks (Layer 3).
 *
 * Extracted from `WebhookDeliveryService` so row mapping and hook matching
 * are unit-testable without D1. The service remains the orchestration
 * facade (enqueue/claim/settle); this module owns the pure row/JSON rules,
 * mirroring the `WebhookRetryPolicy` split.
 */

function toPublicDelivery(row: WebhookDeliveryRow): WebhookDeliveryMetadata {
  return {
    id: row.id,
    hookId: row.hook_id,
    repositoryId: row.repository_id,
    event: row.event,
    eventId: row.event_id,
    status: row.status === 'success' ? 'success' : row.status === 'failed' ? 'failed' : 'pending',
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    lastHttpStatus: row.last_http_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isHookSubscribed(hook: RepoWebhookRow, event: WebhookEventName): boolean {
  if (hook.is_active !== 1) return false;
  try {
    const events: unknown = JSON.parse(hook.events);
    return Array.isArray(events) && events.includes(event);
  } catch {
    return false;
  }
}

function resolveSenderUsername(actorUsername?: string, actorEmail?: string): string {
  return actorUsername ?? actorEmail?.toLowerCase() ?? 'ghost';
}

export { isHookSubscribed, resolveSenderUsername, toPublicDelivery };
