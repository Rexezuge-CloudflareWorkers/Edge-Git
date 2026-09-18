import type { RepoWebhook, WebhookDelivery, WebhookEventName } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';

function authedBase(owner: string, repo: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function hookBase(owner: string, repo: string, hookId: string): string {
  return `${authedBase(owner, repo)}/hooks/${encodeURIComponent(hookId)}`;
}

export async function listWebhooks(owner: string, repo: string): Promise<{ hooks: RepoWebhook[]; events: WebhookEventName[] }> {
  const data = await apiGet<{ hooks?: RepoWebhook[]; events?: WebhookEventName[] }>(`${authedBase(owner, repo)}/hooks`);
  return { hooks: data.hooks ?? [], events: data.events ?? [] };
}

export async function createWebhook(
  owner: string,
  repo: string,
  input: { url: string; events: WebhookEventName[]; secret?: string },
): Promise<{ hook: RepoWebhook; secret: string }> {
  return apiPost<{ hook: RepoWebhook; secret: string }>(`${authedBase(owner, repo)}/hooks`, input);
}

export async function updateWebhook(
  owner: string,
  repo: string,
  hookId: string,
  input: { url?: string; events?: WebhookEventName[]; isActive?: boolean },
): Promise<{ hook: RepoWebhook }> {
  return apiPatch<{ hook: RepoWebhook }>(hookBase(owner, repo, hookId), input);
}

export async function deleteWebhook(owner: string, repo: string, hookId: string): Promise<void> {
  await apiDelete<{ ok: boolean }>(hookBase(owner, repo, hookId));
}

export async function rotateWebhookSecret(owner: string, repo: string, hookId: string): Promise<{ hook: RepoWebhook; secret: string }> {
  return apiPost<{ hook: RepoWebhook; secret: string }>(`${hookBase(owner, repo, hookId)}/rotate-secret`);
}

export async function testWebhook(owner: string, repo: string, hookId: string): Promise<{ delivery: WebhookDelivery }> {
  return apiPost<{ delivery: WebhookDelivery }>(`${hookBase(owner, repo, hookId)}/test`);
}

export async function listWebhookDeliveries(
  owner: string,
  repo: string,
  hookId: string,
  limit = 20,
): Promise<{ deliveries: WebhookDelivery[]; nextCursor: string | null }> {
  const data = await apiGet<{ deliveries?: WebhookDelivery[]; nextCursor?: string | null }>(`${hookBase(owner, repo, hookId)}/deliveries`, {
    limit: String(limit),
  });
  return { deliveries: data.deliveries ?? [], nextCursor: data.nextCursor ?? null };
}

export async function redeliverWebhook(
  owner: string,
  repo: string,
  hookId: string,
  deliveryId: string,
): Promise<{ delivery: WebhookDelivery }> {
  return apiPost<{ delivery: WebhookDelivery }>(`${hookBase(owner, repo, hookId)}/deliveries/${encodeURIComponent(deliveryId)}/redeliver`);
}
