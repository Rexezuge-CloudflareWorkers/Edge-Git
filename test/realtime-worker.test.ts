import { describe, expect, it } from 'vitest';
import { RealtimeWorker } from '@edge-git/background/realtime/RealtimeWorker';

interface FakeSocket {
  sent: string[];
  closed: { code: number; reason: string } | null;
  attachment: unknown;
  failSend: boolean;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(data: unknown): void;
  deserializeAttachment(): unknown;
}

function makeSocket(attachment: unknown = null): FakeSocket {
  return {
    sent: [],
    closed: null,
    attachment,
    failSend: false,
    send(payload: string) {
      if (this.failSend) throw new Error('dead socket');
      this.sent.push(payload);
    },
    close(code = 1000, reason = '') {
      this.closed = { code, reason };
    },
    serializeAttachment(data: unknown) {
      this.attachment = data;
    },
    deserializeAttachment() {
      return this.attachment;
    },
  };
}

function makeCtx(name: string) {
  const store = new Map<string, unknown>();
  const entries: Array<{ ws: FakeSocket; tags: string[] }> = [];
  const ctx = {
    id: { name },
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, value);
      },
      delete: async (key: string) => store.delete(key),
      setAlarm: async () => undefined,
    },
    acceptWebSocket: (ws: FakeSocket, tags: string[] = []) => {
      entries.push({ ws, tags });
    },
    getWebSockets: (tag?: string) =>
      entries.filter((entry) => entry.ws.closed === null && (tag === undefined || entry.tags.includes(tag))).map((entry) => entry.ws),
  };
  return { ctx, store, entries };
}

function makeWorker(name: string, env: Record<string, string> = {}) {
  const { ctx, store, entries } = makeCtx(name);
  const worker = new RealtimeWorker(ctx as unknown as DurableObjectState, env as unknown as Env);
  return { worker, ctx, store, entries };
}

describe('RealtimeWorker tickets', () => {
  it('rejects invalid shards and empty channels without throwing', async () => {
    const { worker } = makeWorker('repo:alice/demo');
    await expect(worker.issueTicket({ shard: 'bogus', channels: ['activity'] })).resolves.toMatchObject({ error: expect.any(String) });
    await expect(worker.issueTicket({ shard: 'repo:alice/demo', channels: [] })).resolves.toMatchObject({ error: expect.any(String) });
    await expect(worker.issueTicket({ shard: 'repo:bob/other', channels: ['activity'] })).resolves.toMatchObject({ error: expect.any(String) });
  });

  it('mints single-use ticket records with TTL metadata', async () => {
    const { worker, store } = makeWorker('repo:alice/demo');
    const issued = await worker.issueTicket({ shard: 'repo:alice/demo', channels: ['issue:1', 'presence'], viewer: 'v@example.com' });
    expect(issued).toMatchObject({ ticket: expect.any(String) });
    if (!('ticket' in issued)) throw new Error('expected ticket');
    const record = store.get(`ticket:${issued.ticket}`) as { shard: string; channels: string[]; viewer: string; expiresAt: number };
    expect(record).toMatchObject({ shard: 'repo:alice/demo', channels: ['issue:1', 'presence'], viewer: 'v@example.com' });
    expect(record.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('garbage-collects expired tickets on alarm', async () => {
    const { worker, store } = makeWorker('repo:alice/demo');
    const now = Math.floor(Date.now() / 1000);
    store.set('ticketIds', ['old', 'live']);
    store.set('ticket:old', { shard: 'repo:alice/demo', channels: ['activity'], viewer: 'a', expiresAt: now - 10 });
    store.set('ticket:live', { shard: 'repo:alice/demo', channels: ['activity'], viewer: 'b', expiresAt: now + 100 });
    await worker.alarm();
    expect(store.has('ticket:old')).toBe(false);
    expect(store.get('ticketIds')).toEqual(['live']);
  });
});

describe('RealtimeWorker publish', () => {
  it('broadcasts to channel-tagged sockets and counts deliveries', async () => {
    const { worker, ctx } = makeWorker('repo:alice/demo');
    const first = makeSocket();
    const second = makeSocket();
    const other = makeSocket();
    ctx.acceptWebSocket(first, ['issue:1']);
    ctx.acceptWebSocket(second, ['issue:1', 'activity']);
    ctx.acceptWebSocket(other, ['activity']);
    const result = await worker.publish({ channel: 'issue:1', type: 'issue_commented', actor: 'a@example.com', title: 'New Comment' });
    expect(result).toEqual({ delivered: 2 });
    expect(first.sent).toHaveLength(1);
    expect(second.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(0);
    const envelope = JSON.parse(first.sent[0]);
    expect(envelope).toMatchObject({ v: 1, channel: 'issue:1', type: 'issue_commented' });
  });

  it('drops invalid channels and dead sockets without throwing', async () => {
    const { worker, ctx } = makeWorker('repo:alice/demo');
    await expect(worker.publish({ channel: 'bogus', type: 'x', title: '' })).resolves.toEqual({ delivered: 0 });
    const dead = makeSocket();
    dead.failSend = true;
    ctx.acceptWebSocket(dead, ['activity']);
    await expect(worker.publish({ channel: 'activity', type: 'repo.push', title: 'Push' })).resolves.toEqual({ delivered: 0 });
  });

  it('fans inbox events out per recipient hash only', async () => {
    const { worker, ctx } = makeWorker('inbox:global');
    const alice = makeSocket();
    const bob = makeSocket();
    ctx.acceptWebSocket(alice, ['inbox:aaaaaaaaaaaaaaaa']);
    ctx.acceptWebSocket(bob, ['inbox:bbbbbbbbbbbbbbbb']);
    const result = await worker.publish({
      channel: 'inbox:aaaaaaaaaaaaaaaa',
      type: 'issue_opened',
      actor: 'c@example.com',
      title: 'Hello',
      recipientHashes: ['aaaaaaaaaaaaaaaa', 'forged!!', 'bbbbbbbbbbbbbbbb'],
    });
    expect(result).toEqual({ delivered: 2 });
    expect(JSON.parse(alice.sent[0]).channel).toBe('inbox:aaaaaaaaaaaaaaaa');
    expect(JSON.parse(bob.sent[0]).channel).toBe('inbox:bbbbbbbbbbbbbbbb');
  });
});

describe('RealtimeWorker client frames', () => {
  it('relays typing indicators to channel subscribers', async () => {
    const { worker, ctx } = makeWorker('repo:alice/demo');
    const author = makeSocket({ viewer: 'a@example.com', channels: ['issue:2'], connectedAt: 0, frameTimes: [] });
    const watcher = makeSocket();
    ctx.acceptWebSocket(author, ['issue:2']);
    ctx.acceptWebSocket(watcher, ['issue:2']);
    await worker.webSocketMessage(author as unknown as WebSocket, JSON.stringify({ kind: 'typing.start', channel: 'issue:2' }));
    expect(watcher.sent).toHaveLength(1);
    expect(JSON.parse(watcher.sent[0])).toMatchObject({ channel: 'issue:2', type: 'typing.started', actor: 'a@example.com' });
  });

  it('ignores frames for unsubscribed channels and forged event kinds', async () => {
    const { worker, ctx } = makeWorker('repo:alice/demo');
    const socket = makeSocket({ viewer: 'a@example.com', channels: ['issue:2'], connectedAt: 0, frameTimes: [] });
    const watcher = makeSocket();
    ctx.acceptWebSocket(socket, ['issue:2']);
    ctx.acceptWebSocket(watcher, ['issue:2']);
    await worker.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ kind: 'typing.start', channel: 'issue:9' }));
    await worker.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ kind: 'issue_commented', channel: 'issue:2' }));
    expect(watcher.sent).toHaveLength(0);
  });

  it('rate-limits chatty sockets', async () => {
    const { worker, ctx } = makeWorker('repo:alice/demo');
    const socket = makeSocket({ viewer: 'a@example.com', channels: ['presence'], connectedAt: 0, frameTimes: [] });
    ctx.acceptWebSocket(socket, ['presence']);
    for (let i = 0; i < 31; i++) {
      await worker.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ kind: 'presence.heartbeat', channel: 'presence' }));
    }
    expect(socket.closed).toMatchObject({ code: 4408 });
  });

  it('broadcasts presence rosters on close', async () => {
    const { worker, ctx } = makeWorker('repo:alice/demo');
    const leaving = makeSocket({ viewer: 'gone@example.com', channels: ['presence'], connectedAt: 0, frameTimes: [] });
    const staying = makeSocket({ viewer: 'here@example.com', channels: ['presence'], connectedAt: 0, frameTimes: [] });
    ctx.acceptWebSocket(leaving, ['presence']);
    ctx.acceptWebSocket(staying, ['presence']);
    // The runtime drops closed sockets from getWebSockets before delivery.
    leaving.closed = { code: 1000, reason: '' };
    await worker.webSocketClose(leaving as unknown as WebSocket, 1000, '', true);
    const updates = staying.sent.map((raw) => JSON.parse(raw)).filter((event) => event.type === 'presence.update');
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0].extra.viewers).toContain('here@example.com');
  });
});
