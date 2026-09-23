import { describe, expect, it } from 'vitest';
import {
  sanitizeRefParam,
  sanitizePathParam,
  sanitizeDepthParam,
  parseOptionalFlag,
} from '../apps/api/src/workers/routes/RepoParamParsers';
import { RealtimeTicketStore } from '../apps/background/src/realtime/RealtimeTicketStore';
import { branchNameSchema, tokenIdSchema } from '../packages/shared/src/validation/schemas';
import { isValidTagName } from '../packages/backend-services/src/release/ReleaseValidation';
import { SearchDAO } from '../packages/backend-data/src/dao/SearchDAO';

function fakeTicketStorage() {
  const data = new Map<string, unknown>();
  const deleted: string[] = [];
  return {
    data,
    deleted,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<boolean> {
      deleted.push(key);
      return data.delete(key);
    },
  };
}

describe('harden codebase: edge param parsers fail fast on traversal', () => {
  it('rejects traversal and git-dangerous refs', () => {
    expect(sanitizeRefParam('main')).toBe('main');
    expect(sanitizeRefParam('feat/foo-1')).toBe('feat/foo-1');
    expect(sanitizeRefParam('../escape')).toBeUndefined();
    expect(sanitizeRefParam('a//b')).toBeUndefined();
    expect(sanitizeRefParam('/abs')).toBeUndefined();
    expect(sanitizeRefParam('a@{1}')).toBeUndefined();
    expect(sanitizeRefParam('bad~name')).toBeUndefined();
    expect(sanitizeRefParam('v1.locked')).toBe('v1.locked');
    expect(sanitizeRefParam('feature.lock')).toBeUndefined();
    expect(sanitizeRefParam(null)).toBeUndefined();
  });

  it('rejects filesystem traversal in paths', () => {
    expect(sanitizePathParam('README.md')).toBe('README.md');
    expect(sanitizePathParam('src/index.ts')).toBe('src/index.ts');
    expect(sanitizePathParam('../secret')).toBeUndefined();
    expect(sanitizePathParam('a/../../b')).toBeUndefined();
    expect(sanitizePathParam('/etc/passwd')).toBeUndefined();
    expect(sanitizePathParam('a\\b')).toBeUndefined();
    expect(sanitizePathParam('a//b')).toBeUndefined();
    expect(sanitizePathParam(null)).toBeUndefined();
  });

  it('caps depth and rejects garbage flags', () => {
    expect(sanitizeDepthParam('5')).toBe(5);
    expect(sanitizeDepthParam('0')).toBeUndefined();
    expect(sanitizeDepthParam('51')).toBeUndefined();
    expect(sanitizeDepthParam('NaN')).toBeUndefined();
    expect(parseOptionalFlag('yes')).toBe(true);
    expect(parseOptionalFlag('no')).toBe(false);
    expect(parseOptionalFlag('garbage')).toBeUndefined();
  });
});

describe('harden codebase: realtime tickets expire and do not leak', () => {
  it('clamps ttl and validates inputs', async () => {
    const storage = fakeTicketStorage();
    const store = new RealtimeTicketStore(storage);
    await expect(store.mint('', ['c'], 'v@x.co', 30)).rejects.toThrow();
    await expect(store.mint('s', ['c'], '', 30)).rejects.toThrow();
    const { ticket, expiresAt } = await store.mint('repo:a/b', ['repo:a/b'], 'v@x.co', 9999);
    expect(ticket).toMatch(/^[0-9a-f]{32}$/i);
    expect(expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 301);
  });

  it('redeem rejects invalid format and expired records', async () => {
    const storage = fakeTicketStorage();
    const store = new RealtimeTicketStore(storage);
    expect(await store.redeem('not-a-uuid')).toBeUndefined();
    const { ticket } = await store.mint('s', [], 'v@x.co', 30);
    // Force expiry by overwriting the stored record.
    const record = storage.data.get(`ticket:${ticket}`) as { expiresAt: number };
    storage.data.set(`ticket:${ticket}`, { ...record, expiresAt: 1 });
    expect(await store.redeem(ticket)).toBeUndefined();
  });

  it('evicts oldest ticket keys instead of leaking them', async () => {
    const storage = fakeTicketStorage();
    storage.data.set(
      'ticketIds',
      Array.from({ length: 200 }, (_, i) => `id-${i}`),
    );
    for (const id of Array.from({ length: 200 }, (_, i) => `id-${i}`)) {
      storage.data.set(`ticket:${id}`, { shard: 's', channels: [], viewer: 'v', expiresAt: 9_999_999_999 });
    }
    const store = new RealtimeTicketStore(storage);
    await store.mint('s', [], 'v@x.co', 30);
    const ids = storage.data.get('ticketIds') as string[];
    expect(ids).toHaveLength(200);
    expect(storage.deleted.some((k) => k === 'ticket:id-0')).toBe(true);
  });
});

describe('harden codebase: route edge validation reuses shared schemas', () => {
  it('branch names reject traversal', () => {
    expect(branchNameSchema.safeParse('main').success).toBe(true);
    expect(branchNameSchema.safeParse('../escape').success).toBe(false);
    expect(branchNameSchema.safeParse('a//b').success).toBe(false);
  });

  it('hook ids must be uuids', () => {
    expect(tokenIdSchema.safeParse('not-a-uuid').success).toBe(false);
    expect(tokenIdSchema.safeParse('123e4567-e89b-12d3-a456-426614174000').success).toBe(true);
  });

  it('release tags reject traversal', () => {
    expect(isValidTagName('v1.2.3')).toBe(true);
    expect(isValidTagName('../evil')).toBe(false);
    expect(isValidTagName('a//b')).toBe(false);
  });
});

describe('harden codebase: search degrades to [] on empty query', () => {
  it('returns [] without touching D1', async () => {
    let calls = 0;
    const fakeDb = {
      prepare: () => {
        calls += 1;
        throw new Error('should not be called');
      },
    };
    const dao = new SearchDAO(fakeDb as never);
    expect(await dao.searchRepos('   ')).toEqual([]);
    expect(await dao.searchIssues('')).toEqual([]);
    expect(await dao.searchCode('   ')).toEqual([]);
    expect(calls).toBe(0);
  });
});
