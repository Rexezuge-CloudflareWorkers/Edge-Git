// Client mirror of the server realtime protocol (`@edge-git/shared/realtime`).
// The SPA has no workspace dependency on `@edge-git/shared`, so the envelope
// shape and channel builders are duplicated here — keep them in sync.

export interface RealtimeEnvelope {
  v: 1;
  id: string;
  ts: number;
  channel: string;
  type: string;
  actor: string;
  title: string;
  subjectType: string | null;
  subjectNumber: number | null;
  sha: string | null;
  extra: Record<string, unknown>;
}

export interface PresenceUpdate {
  viewers: string[];
  count: number;
}

const CHANNEL_RE = /^(?:activity|presence|issue:\d{1,10}|pr:\d{1,10}|checks:[0-9a-f]{4,64}|inbox:[0-9a-f]{16,64})$/;

export function isRealtimeEnvelope(value: unknown): value is RealtimeEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return (
    event.v === 1 &&
    typeof event.id === 'string' &&
    typeof event.ts === 'number' &&
    typeof event.channel === 'string' &&
    CHANNEL_RE.test(event.channel) &&
    typeof event.type === 'string' &&
    typeof event.actor === 'string' &&
    typeof event.title === 'string'
  );
}

export function presenceFromEnvelope(event: RealtimeEnvelope): PresenceUpdate | null {
  if (event.type !== 'presence.update') return null;
  const extra = event.extra as { viewers?: unknown; count?: unknown };
  if (!Array.isArray(extra.viewers)) return null;
  const viewers = extra.viewers.filter((v): v is string => typeof v === 'string').slice(0, 20);
  return { viewers, count: typeof extra.count === 'number' ? extra.count : viewers.length };
}

export function issueChannel(number: number): string {
  return `issue:${number}`;
}

export function pullChannel(number: number): string {
  return `pr:${number}`;
}

export function checksChannel(sha: string): string | null {
  const normalized = sha.toLowerCase();
  if (!/^[0-9a-f]{4,64}$/.test(normalized)) return null;
  return `checks:${normalized}`;
}
