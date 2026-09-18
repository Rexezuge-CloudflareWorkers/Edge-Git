import { useEffect, useRef, useState } from 'react';
import { isRealtimeEnvelope, presenceFromEnvelope } from './protocol';
import type { RealtimeEnvelope } from './protocol';
import { fetchInboxTicket, fetchRepoTicket, realtimeWsUrl } from '../services/realtimeService';
import type { RealtimeTicket } from '../services/realtimeService';

export type RealtimeStatus = 'live' | 'connecting' | 'offline';
export type TicketRequest =
  | { kind: 'repo'; owner: string; repo: string; channels: string[] }
  | { kind: 'inbox' };

const BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000];
const FALLBACK_RETRY_MS = 30_000;
const TYPING_VISIBLE_MS = 6000;

function ticketKeyFor(ticket: TicketRequest): string {
  if (ticket.kind === 'inbox') return 'inbox';
  return `${ticket.owner}/${ticket.repo}:${[...ticket.channels].sort((a, b) => a.localeCompare(b)).join(',')}`;
}

function backoffDelay(attempts: number): number {
  if (attempts < 0) return BACKOFF_MS[0] ?? 1000;
  // eslint-disable-next-line unicorn/prefer-at -- web tsconfig targets ES2020 (no Array#at)
  if (attempts >= BACKOFF_MS.length) return BACKOFF_MS[BACKOFF_MS.length - 1] ?? FALLBACK_RETRY_MS;
  return BACKOFF_MS[attempts] ?? FALLBACK_RETRY_MS;
}

async function mintTicket(request: TicketRequest): Promise<RealtimeTicket | null> {
  if (request.kind === 'repo' && request.channels.length === 0) return null;
  try {
    if (request.kind === 'inbox') return await fetchInboxTicket();
    return await fetchRepoTicket(request.owner, request.repo, request.channels);
  } catch {
    // 403/404/503 or signed-out: caller stays on polling fallback.
    return null;
  }
}

interface ConnectionCallbacks {
  onStatus(status: RealtimeStatus): void;
  onEnvelope(event: RealtimeEnvelope): void;
  onPresence(viewers: string[]): void;
  onTyping(actor: string, visible: boolean): void;
}

interface ConnectionState {
  cancelled: boolean;
  attempts: number;
  socket: WebSocket | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

function clearRetry(state: ConnectionState): void {
  if (!state.retryTimer) return;
  clearTimeout(state.retryTimer);
  state.retryTimer = null;
}

function scheduleReconnect(state: ConnectionState, ticket: TicketRequest, callbacks: ConnectionCallbacks): void {
  if (state.cancelled) return;
  callbacks.onStatus('connecting');
  const delay = backoffDelay(state.attempts);
  state.attempts += 1;
  clearRetry(state);
  state.retryTimer = setTimeout(() => {
    void openConnection(state, ticket, callbacks);
  }, delay);
}

function handleMessageText(state: ConnectionState, ticket: TicketRequest, callbacks: ConnectionCallbacks, data: unknown): void {
  if (typeof data !== 'string' || state.cancelled) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (!isRealtimeEnvelope(parsed)) return;
  if (parsed.type === 'presence.update') {
    const presence = presenceFromEnvelope(parsed);
    if (presence) callbacks.onPresence(presence.viewers);
    return;
  }
  if (parsed.type === 'typing.started') {
    callbacks.onTyping(parsed.actor || parsed.title, true);
    return;
  }
  if (parsed.type === 'typing.stopped') {
    callbacks.onTyping(parsed.actor || parsed.title, false);
    return;
  }
  callbacks.onEnvelope(parsed);
}

function attachSocket(state: ConnectionState, ticket: TicketRequest, callbacks: ConnectionCallbacks, socket: WebSocket): void {
  state.socket = socket;
  socket.addEventListener('open', () => {
    if (state.cancelled) return;
    state.attempts = 0;
    callbacks.onStatus('live');
  });
  socket.addEventListener('message', (event: MessageEvent) => {
    handleMessageText(state, ticket, callbacks, event.data);
  });
  socket.addEventListener('close', () => {
    if (state.cancelled) return;
    if (state.socket === socket) state.socket = null;
    scheduleReconnect(state, ticket, callbacks);
  });
  socket.addEventListener('error', () => {
    try {
      socket.close();
    } catch {
      // close handler schedules the reconnect
    }
  });
}

async function openConnection(state: ConnectionState, ticket: TicketRequest, callbacks: ConnectionCallbacks): Promise<void> {
  if (state.cancelled) return;
  callbacks.onStatus('connecting');
  const grant = await mintTicket(ticket);
  if (state.cancelled) return;
  if (!grant) {
    callbacks.onStatus('offline');
    clearRetry(state);
    state.retryTimer = setTimeout(() => {
      void openConnection(state, ticket, callbacks);
    }, FALLBACK_RETRY_MS);
    return;
  }
  let socket: WebSocket;
  try {
    socket = new WebSocket(realtimeWsUrl(grant.shard, grant.ticket));
  } catch {
    callbacks.onStatus('offline');
    return;
  }
  attachSocket(state, ticket, callbacks, socket);
}

function closeConnection(state: ConnectionState): void {
  state.cancelled = true;
  clearRetry(state);
  const socket = state.socket;
  state.socket = null;
  if (socket) {
    try {
      socket.close();
    } catch {
      // already closed
    }
  }
}

function markTyping(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  setTyping: (update: (prev: string[]) => string[]) => void,
  actor: string,
  visible: boolean,
): void {
  const existing = timers.get(actor);
  if (existing) {
    clearTimeout(existing);
    timers.delete(actor);
  }
  if (!visible) {
    setTyping((prev) => prev.filter((name) => name !== actor));
    return;
  }
  const timer = setTimeout(() => {
    timers.delete(actor);
    setTyping((prev) => prev.filter((name) => name !== actor));
  }, TYPING_VISIBLE_MS);
  timers.set(actor, timer);
  setTyping((prev) => (prev.includes(actor) ? prev : [...prev, actor]));
}

function createCallbacks(
  setStatus: (status: RealtimeStatus) => void,
  setViewers: (viewers: string[]) => void,
  setTyping: (update: (prev: string[]) => string[]) => void,
  timers: Map<string, ReturnType<typeof setTimeout>>,
  onEventRef: { current: (event: RealtimeEnvelope) => void },
): ConnectionCallbacks {
  return {
    onStatus: (next) => {
      setStatus(next);
    },
    onEnvelope: (event) => {
      onEventRef.current(event);
    },
    onPresence: (next) => {
      setViewers(next);
    },
    onTyping: (actor, visible) => {
      markTyping(timers, setTyping, actor, visible);
    },
  };
}

// Shared live-update subscription. Fetches a fresh single-use ticket per
// (re)connect, reconnects with backoff, and degrades to `offline` (callers
// keep their existing polling/manual refresh) when tickets or sockets fail.
export function useRealtimeSubscription(options: {
  enabled: boolean;
  ticket: TicketRequest;
  onEvent: (event: RealtimeEnvelope) => void;
}): { status: RealtimeStatus; viewers: string[]; typing: string[]; sendTyping: (channel: string) => void } {
  const { enabled, ticket } = options;
  const [status, setStatus] = useState<RealtimeStatus>('offline');
  const [viewers, setViewers] = useState<string[]>([]);
  const [typing, setTyping] = useState<string[]>([]);
  const onEventRef = useRef(options.onEvent);
  const stateRef = useRef<ConnectionState | null>(null);
  const typingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    onEventRef.current = options.onEvent;
  });

  const key = ticketKeyFor(ticket);

  useEffect(() => {
    if (!enabled) return undefined;
    const state: ConnectionState = { cancelled: false, attempts: 0, socket: null, retryTimer: null };
    stateRef.current = state;
    const callbacks = createCallbacks(setStatus, setViewers, setTyping, typingTimers.current, onEventRef);
    void openConnection(state, ticket, callbacks);
    return () => {
      closeConnection(state);
      if (stateRef.current === state) stateRef.current = null;
      for (const timer of typingTimers.current.values()) clearTimeout(timer);
      typingTimers.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key]);

  const sendTyping = (channel: string) => {
    const socket = stateRef.current?.socket ?? null;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ kind: 'typing.start', channel }));
    } catch {
      // socket dying; reconnect loop covers it
    }
  };

  return { status: enabled ? status : 'offline', viewers, typing, sendTyping };
}
