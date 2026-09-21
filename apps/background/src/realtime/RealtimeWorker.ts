import { DurableObject } from 'cloudflare:workers';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { createLogger } from '@edge-git/backend-runtime/logger';
import {
  MAX_CHANNELS_PER_SOCKET,
  MAX_CLIENT_FRAMES_PER_MINUTE,
  MAX_MESSAGE_BYTES,
  buildEnvelope,
  inboxTagForHash,
  isChannel,
  isShard,
  normalizeChannels,
  parseClientFrame,
} from '@edge-git/shared/realtime';
import type { RealtimeEnvelope } from '@edge-git/shared/realtime';
import { TimestampUtil, UUIDUtil } from '@edge-git/shared/utils';
import { pickEvictionCandidate, pruneFrameTimes, shouldRateLimit } from './RealtimePolicy';

const logger = createLogger('RealtimeWorker');

interface TicketRecord {
  shard: string;
  channels: string[];
  viewer: string;
  expiresAt: number;
}

interface SocketAttachment {
  viewer: string;
  channels: string[];
  connectedAt: number;
  frameTimes: number[];
}

interface IssueTicketInput {
  shard: string;
  channels: string[];
  viewer?: string;
  ttlSeconds?: number;
}

interface PublishInput {
  channel: string;
  type: string;
  actor?: string;
  title?: string;
  subjectType?: string | null;
  subjectNumber?: number | null;
  sha?: string | null;
  extra?: Record<string, unknown>;
  recipientHashes?: string[];
}

// Live-update fan-out: one hibernatable-WebSocket DO per repo shard
// (`REALTIME.getByName('repo:<owner>/<name>')`) plus a single global inbox
// shard (`inbox:global`). Idle hibernated sockets cost ~0 duration, and one
// RPC `publish()` fans out to every tagged socket — N recipients still cost a
// single DO request, which keeps the Workers Free 100k req/day budget intact.
// Tickets and presence live in DO storage / socket attachments only: zero D1
// writes on the hot path. Never throws across RPC boundaries.
class RealtimeWorker extends DurableObject<Env> {
  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws' && request.method === 'GET') {
      return this.acceptTicketSocket(request, url.searchParams.get('shard') ?? '', url.searchParams.get('ticket') ?? '');
    }
    return new Response('Not Found', { status: 404 });
  }

  // Server-only ticket minting (called via DO RPC from the API Worker after
  // `RealtimeService` authorized the channels — never exposed over fetch).
  public async issueTicket(input: IssueTicketInput): Promise<{ ticket: string; expiresAt: number } | { error: string }> {
    try {
      if (!input || !isShard(input.shard)) return { error: 'invalid shard' };
      const ownName = this.ctx.id?.name;
      if (ownName && input.shard !== ownName) return { error: 'shard mismatch' };
      const channels = normalizeChannels(input.channels, MAX_CHANNELS_PER_SOCKET);
      if (channels.length === 0) return { error: 'no channels' };
      const viewer = typeof input.viewer === 'string' && input.viewer.length > 0 ? input.viewer.slice(0, 320) : 'anonymous';
      const ttl = this.ticketTtlSeconds();
      const expiresAt = TimestampUtil.getCurrentUnixTimestampInSeconds() + ttl;
      const ticket = UUIDUtil.getRandomUUIDNoDash();
      const existing = ((await this.ctx.storage.get<string[]>('ticketIds')) ?? []).filter((id) => typeof id === 'string');
      await this.ctx.storage.put(`ticket:${ticket}`, { shard: input.shard, channels, viewer, expiresAt } satisfies TicketRecord);
      await this.ctx.storage.put('ticketIds', [...existing, ticket].slice(-200));
      await this.ctx.storage.setAlarm(Date.now() + ttl * 1000 + 5000).catch(() => undefined);
      return { ticket, expiresAt };
    } catch (error) {
      logger.error('RealtimeWorker: issueTicket failed', error);
      return { error: 'unavailable' };
    }
  }

  // Server-only fan-out (called via DO RPC from `waitUntil` publish hooks).
  // `inbox:*` channels plus `recipientHashes` target per-user inbox tags on
  // the global shard; any other channel broadcasts to that channel tag.
  // Plain (non-async) promise returns: RPC still serializes them, and the
  // try/catch keeps the never-throw guarantee without spurious awaits.
  public publish(input: PublishInput): Promise<{ delivered: number }> {
    try {
      if (!input || !isChannel(input.channel)) return Promise.resolve({ delivered: 0 });
      if (input.channel.startsWith('inbox:')) {
        return Promise.resolve({ delivered: this.publishInbox(input) });
      }
      const envelope = buildEnvelope({
        id: UUIDUtil.getRandomUUID(),
        ts: TimestampUtil.getCurrentUnixTimestampInSeconds(),
        channel: input.channel,
        type: input.type,
        actor: typeof input.actor === 'string' ? input.actor : '',
        title: typeof input.title === 'string' ? input.title : '',
        subjectType: input.subjectType,
        subjectNumber: input.subjectNumber,
        sha: input.sha,
        extra: input.extra,
      });
      if (!envelope) return Promise.resolve({ delivered: 0 });
      return Promise.resolve({ delivered: this.broadcast(input.channel, envelope) });
    } catch (error) {
      logger.error('RealtimeWorker: publish failed', error);
      return Promise.resolve({ delivered: 0 });
    }
  }

  // One envelope per recipient tag so each inbox socket only ever sees its
  // own user's pings. Hashes are validated — forged tags never match.
  private publishInbox(input: PublishInput): number {
    const hashes = Array.isArray(input.recipientHashes) ? input.recipientHashes : [];
    const seen = new Set<string>();
    let delivered = 0;
    for (const hash of hashes) {
      if (typeof hash !== 'string' || seen.has(hash)) continue;
      seen.add(hash);
      if (seen.size > 500) break;
      const tag = inboxTagForHash(hash);
      if (!isChannel(tag)) continue;
      const envelope = buildEnvelope({
        id: UUIDUtil.getRandomUUID(),
        ts: TimestampUtil.getCurrentUnixTimestampInSeconds(),
        channel: tag,
        type: input.type,
        actor: typeof input.actor === 'string' ? input.actor : '',
        title: typeof input.title === 'string' ? input.title : '',
        subjectType: input.subjectType,
        subjectNumber: input.subjectNumber,
        sha: input.sha,
        extra: input.extra,
      });
      if (envelope) delivered += this.broadcast(tag, envelope);
    }
    return delivered;
  }

  public getStats(): Promise<{ connections: number }> {
    try {
      return Promise.resolve({ connections: this.ctx.getWebSockets().length });
    } catch {
      return Promise.resolve({ connections: 0 });
    }
  }

  public override async alarm(): Promise<void> {
    try {
      const ids = (await this.ctx.storage.get<string[]>('ticketIds')) ?? [];
      if (ids.length === 0) return;
      const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
      const live: string[] = [];
      for (const id of ids) {
        const record = await this.ctx.storage.get<TicketRecord>(`ticket:${id}`).catch(() => null);
        if (record && record.expiresAt > now) {
          live.push(id);
        } else {
          await this.ctx.storage.delete(`ticket:${id}`).catch(() => undefined);
        }
      }
      await this.ctx.storage.put('ticketIds', live.slice(-200)).catch(() => undefined);
    } catch (error) {
      logger.error('RealtimeWorker: alarm GC failed', error);
    }
  }

  public override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string' || message.length === 0 || message.length > MAX_MESSAGE_BYTES) return;
    const attachment = this.readAttachment(ws);
    if (!attachment) return;
    if (!this.checkRateLimit(ws, attachment)) return;
    const frame = parseClientFrame(message);
    if (!frame || !attachment.channels.includes(frame.channel)) return;
    // Typing indicators relay to the channel; presence heartbeats refresh the
    // roster view. Neither is persisted — live state only.
    if (frame.kind === 'typing.start' || frame.kind === 'typing.stop') {
      const envelope = buildEnvelope({
        id: UUIDUtil.getRandomUUID(),
        ts: TimestampUtil.getCurrentUnixTimestampInSeconds(),
        channel: frame.channel,
        type: frame.kind === 'typing.start' ? 'typing.started' : 'typing.stopped',
        actor: attachment.viewer,
        title: frame.name ?? attachment.viewer,
      });
      if (envelope) this.broadcast(frame.channel, envelope);
      return;
    }
    this.broadcastPresence(frame.channel);
  }

  public override webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    const attachment = this.readAttachment(ws);
    if (!attachment) return;
    if (attachment.channels.includes('presence')) this.broadcastPresence('presence');
  }

  public override webSocketError(ws: WebSocket, _error: unknown): void {
    try {
      ws.close(1011, 'internal error');
    } catch {
      // already gone
    }
  }

  private async acceptTicketSocket(request: Request, shard: string, ticket: string): Promise<Response> {
    if (!isShard(shard)) return new Response('Not Found', { status: 404 });
    const ownName = this.ctx.id?.name;
    if (ownName && shard !== ownName) return new Response('Not Found', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ Exception: { Type: 'MethodNotAllowed', Message: 'WebSocket upgrade required.' } }, { status: 426 });
    }
    if (!this.isRealtimeEnabled())
      return Response.json({ Exception: { Type: 'InternalServerError', Message: 'Realtime is disabled.' } }, { status: 503 });
    let record: TicketRecord | undefined;
    try {
      record = await this.ctx.storage.get<TicketRecord>(`ticket:${ticket}`);
    } catch {
      record = undefined;
    }
    // Single-use: redeem (delete) before anything else so replays fail.
    if (ticket) await this.ctx.storage.delete(`ticket:${ticket}`).catch(() => undefined);
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    if (!record || record.shard !== shard || record.expiresAt <= now || record.channels.length === 0) {
      return Response.json({ Exception: { Type: 'Unauthorized', Message: 'Invalid or expired ticket.' } }, { status: 401 });
    }
    if (!this.makeRoom(record.viewer)) {
      return Response.json({ Exception: { Type: 'InternalServerError', Message: 'Too many connections.' } }, { status: 503 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = {
      viewer: record.viewer,
      channels: record.channels.slice(0, MAX_CHANNELS_PER_SOCKET),
      connectedAt: Date.now(),
      frameTimes: [],
    };
    try {
      this.ctx.acceptWebSocket(server, attachment.channels);
      server.serializeAttachment(attachment);
    } catch (error) {
      logger.error('RealtimeWorker: acceptWebSocket failed', error);
      return Response.json({ Exception: { Type: 'InternalServerError', Message: 'Realtime is unavailable.' } }, { status: 503 });
    }
    try {
      server.send(JSON.stringify({ v: 1, type: 'hello', shard, channels: attachment.channels }));
    } catch {
      // hello is a nicety; the socket is still usable
    }
    if (attachment.channels.includes('presence')) this.broadcastPresence('presence');
    return new Response(null, { status: 101, webSocket: client });
  }

  private broadcast(channel: string, envelope: RealtimeEnvelope): number {
    let delivered = 0;
    let sockets: WebSocket[];
    try {
      sockets = this.ctx.getWebSockets(channel);
    } catch {
      return 0;
    }
    const payload = JSON.stringify(envelope);
    for (const socket of sockets) {
      try {
        socket.send(payload);
        delivered += 1;
      } catch {
        // dead socket; close delivery prunes it
      }
    }
    return delivered;
  }

  private broadcastPresence(channel: string): void {
    const viewers = new Set<string>();
    try {
      for (const socket of this.ctx.getWebSockets(channel)) {
        const attachment = this.readAttachment(socket);
        if (attachment?.viewer) viewers.add(attachment.viewer);
        if (viewers.size >= 20) break;
      }
    } catch {
      return;
    }
    const envelope = buildEnvelope({
      id: UUIDUtil.getRandomUUID(),
      ts: TimestampUtil.getCurrentUnixTimestampInSeconds(),
      channel,
      type: 'presence.update',
      actor: '',
      title: `${viewers.size} Viewing`,
      extra: { viewers: [...viewers], count: viewers.size },
    });
    if (envelope) this.broadcast(channel, envelope);
  }

  private readAttachment(ws: WebSocket): SocketAttachment | null {
    try {
      const attachment = ws.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || !Array.isArray(attachment.channels)) return null;
      return attachment;
    } catch {
      return null;
    }
  }

  // Per-socket token bucket over the last 60s. Mutates the attachment so the
  // window survives hibernation evictions. Pure window math lives in
  // `./RealtimePolicy.ts` (unit testable without DO hibernation).
  private checkRateLimit(ws: WebSocket, attachment: SocketAttachment): boolean {
    const now = Date.now();
    const windowed = pruneFrameTimes(attachment.frameTimes, now);
    if (shouldRateLimit(attachment.frameTimes, now, MAX_CLIENT_FRAMES_PER_MINUTE)) {
      try {
        ws.close(4408, 'rate limited');
      } catch {
        // already gone
      }
      return false;
    }
    windowed.push(now);
    try {
      ws.serializeAttachment({ ...attachment, frameTimes: windowed.slice(-MAX_CLIENT_FRAMES_PER_MINUTE) });
    } catch {
      // attachment write is best-effort
    }
    return true;
  }

  // Connection caps bound free-plan duration. Anonymous sockets yield to
  // authenticated viewers when a shard is full. Victim selection lives in
  // `./RealtimePolicy.ts` (pure, unit testable).
  private makeRoom(viewer: string): boolean {
    let sockets: WebSocket[];
    try {
      sockets = this.ctx.getWebSockets();
    } catch {
      return false;
    }
    const max = this.maxConnections();
    const attachments = sockets.map((socket) => ({ viewer: this.readAttachment(socket)?.viewer ?? 'anonymous' }));
    const victim = pickEvictionCandidate(attachments, viewer, max);
    if (victim === -2) return true;
    if (victim === -1) return false;
    try {
      sockets[victim]?.close(4409, 'evicted for authenticated viewer');
    } catch {
      // already gone — room freed anyway
    }
    return true;
  }

  private isRealtimeEnabled(): boolean {
    try {
      return ConfigurationManager.realtime.isEnabled(this.env);
    } catch {
      return false;
    }
  }

  private ticketTtlSeconds(): number {
    try {
      return ConfigurationManager.realtime.getTicketTtlSeconds(this.env);
    } catch {
      return 30;
    }
  }

  private maxConnections(): number {
    try {
      const ownName = this.ctx.id?.name ?? '';
      if (ownName === 'inbox:global') return ConfigurationManager.realtime.getMaxConnPerInboxShard(this.env);
      return ConfigurationManager.realtime.getMaxConnPerRepoShard(this.env);
    } catch {
      return 100;
    }
  }
}

export { RealtimeWorker };
export type { IssueTicketInput, PublishInput };
