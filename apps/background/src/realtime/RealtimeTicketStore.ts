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

  public async mint(shard: string, channels: string[], viewer: string, ttlSeconds: number): Promise<{ ticket: string; expiresAt: number }> {
    const expiresAt = TimestampUtil.getCurrentUnixTimestampInSeconds() + ttlSeconds;
    const ticket = UUIDUtil.getRandomUUIDNoDash();
    const existing = ((await this.storage.get<string[]>('ticketIds').catch(() => [] as string[])) ?? []).filter(
      (id) => typeof id === 'string',
    );
    await this.storage.put(`ticket:${ticket}`, { shard, channels, viewer, expiresAt } satisfies TicketRecord);
    await this.storage.put('ticketIds', [...existing, ticket].slice(-200));
    await this.storage.setAlarm?.(Date.now() + ttlSeconds * 1000 + 5000).catch(() => undefined);
    return { ticket, expiresAt };
  }

  public async redeem(ticket: string): Promise<TicketRecord | undefined> {
    if (!ticket) return undefined;
    let record: TicketRecord | undefined;
    try {
      record = await this.storage.get<TicketRecord>(`ticket:${ticket}`);
    } catch {
      record = undefined;
    }
    await this.storage.delete(`ticket:${ticket}`).catch(() => undefined);
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
