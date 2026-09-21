import { apiGet, apiPost } from '../lib/api';

export interface RealtimeTicket {
  shard: string;
  ticket: string;
  expiresAt: number;
  channels: string[];
}

export const REALTIME_DISABLED_MESSAGE = 'Realtime is disabled';

export function isRealtimeDisabledError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const normalized = error.message.trim().replace(/\.$/, '');
  return normalized === REALTIME_DISABLED_MESSAGE;
}

export async function fetchRepoTicket(owner: string, repo: string, channels: string[]): Promise<RealtimeTicket> {
  return apiPost<RealtimeTicket>('/user/realtime/ticket', { owner, repo, channels });
}

export async function fetchInboxTicket(): Promise<RealtimeTicket> {
  return apiGet<RealtimeTicket>('/user/realtime/inbox-ticket');
}

export function realtimeWsUrl(shard: string, ticket: string): string {
  const protocol = globalThis.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${globalThis.location.host}/realtime/ws?shard=${encodeURIComponent(shard)}&ticket=${encodeURIComponent(ticket)}`;
}
