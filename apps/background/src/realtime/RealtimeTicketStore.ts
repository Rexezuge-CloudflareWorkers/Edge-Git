import { TimestampUtil, UUIDUtil } from '@edge-git/shared/utils';

interface TicketRecord {
  shard: string;
  channels: string[];
  viewer: string;
  expiresAt: number;
}

interface TicketStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm?(when: number): Promise<void>;
}

class RealtimeTicketStore {
  constructor(private readonly storage: TicketStorage) {}

  // TTL is clamped to 1..300s (default 30s): prevents immortal tickets from
  // huge values and immediate-expiry churn from 0/negative inputs.
  private static normalizeTtl(ttlSeconds: number): number {
    if (!Number.isSafeInteger(ttlSeconds)) return 30;
    return Math.min(Math.max(ttlSeconds, 1), 300);
  }

  public async mint(shard: string, channels: string[], viewer: string, ttlSeconds: number): Promise<{ ticket: string; expiresAt: number }> {
    if (!shard.trim()) throw new Error('shard is required');
    if (!viewer.trim()) throw new Error('viewer is required');
    const cleanShard = shard.trim().slice(0, 256);
    const cleanViewer = viewer.trim().slice(0, 320);
    const cleanChannels = channels
      .filter((ch) => typeof ch === 'string' && ch.trim())
      .map((ch) => ch.trim().slice(0, 256))
      .slice(0, 50);
    const ttl = RealtimeTicketStore.normalizeTtl(ttlSeconds);
    const expiresAt = TimestampUtil.getCurrentUnixTimestampInSeconds() + ttl;
    const ticket = UUIDUtil.getRandomUUIDNoDash();
    if (!/^[0-9a-f]{32}$/i.test(ticket)) throw new Error('ticket format invalid');
    const existing = ((await this.storage.get<string[]>('ticketIds').catch(() => [] as string[])) ?? []).filter(
      (id) => typeof id === 'string',
    );
    await this.storage.put(`ticket:${ticket}`, {
      shard: cleanShard,
      channels: cleanChannels,
      viewer: cleanViewer,
      expiresAt,
    } satisfies TicketRecord);
    // Evict oldest ids beyond the 200 cap AND delete their keys so storage
    // does not leak orphaned `ticket:<id>` rows.
    const next = [...existing, ticket].slice(-200);
    const evicted = new Set(existing.filter((id) => !next.includes(id)));
    await this.storage.put('ticketIds', next);
    for (const id of evicted) {
      await this.storage.delete(`ticket:${id}`).catch(() => undefined);
    }
    await this.storage.setAlarm?.(Date.now() + ttl * 1000 + 5000).catch(() => undefined);
    return { ticket, expiresAt };
  }

  public async redeem(ticket: string): Promise<TicketRecord | undefined> {
    if (!ticket || !/^[0-9a-f]{32}$/i.test(ticket)) return undefined;
    let record: TicketRecord | undefined;
    try {
      record = await this.storage.get<TicketRecord>(`ticket:${ticket}`);
    } catch {
      record = undefined;
    }
    await this.storage.delete(`ticket:${ticket}`).catch(() => undefined);
    // Single-use + expiry enforced: expired tickets redeem to undefined so a
    // stolen/expired ticket can never upgrade to a socket.
    if (!record) return undefined;
    if (typeof record.expiresAt !== 'number' || record.expiresAt <= TimestampUtil.getCurrentUnixTimestampInSeconds()) {
      return undefined;
    }
    return record;
  }

  public async collectGarbage(nowSeconds: number = TimestampUtil.getCurrentUnixTimestampInSeconds()): Promise<void> {
    const ids = (await this.storage.get<string[]>('ticketIds').catch(() => [] as string[])) ?? [];
    if (ids.length === 0) return;
    const live: string[] = [];
    for (const id of ids) {
      const record = await this.storage.get<TicketRecord>(`ticket:${id}`).catch(() => null);
      if (record && record.expiresAt > nowSeconds) live.push(id);
      else await this.storage.delete(`ticket:${id}`).catch(() => undefined);
    }
    await this.storage.put('ticketIds', live.slice(-200)).catch(() => undefined);
  }
}

export { RealtimeTicketStore };
export type { TicketRecord, TicketStorage };
