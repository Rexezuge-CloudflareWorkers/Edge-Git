import { describe, expect, it } from 'vitest';
import { NotificationDAO } from '@edge-git/backend-data/dao';
import { NotificationService } from '@edge-git/backend-services/social';
import { RealtimeService } from '@edge-git/backend-services/realtime';

/**
 * The inbox follows the account, not the address.
 *
 * Notifications used to be matched on `user_email`, and the realtime inbox shard
 * was `sha256(email)`. Both meant an address change stranded a user's history
 * and silently re-sharded their live subscription.
 *
 * The DAO assertions target the generated SQL and its binds rather than
 * simulating SQLite: the predicate is the contract, it is what decides whose
 * rows a caller can read, and asserting it directly is not a tautology.
 */

const ALICE = 'usr_'.padEnd(36, 'a');
const BOB = 'usr_'.padEnd(36, 'b');

/** Captures the statement the DAO builds, without emulating a database. */
function capture(): { db: unknown; last: () => { sql: string; params: unknown[] } } {
  let lastQuery = '';
  let lastParams: unknown[] = [];
  const db = {
    prepare: (query: string) => {
      lastQuery = query;
      lastParams = [];
      const run = async (): Promise<{ success: true; meta: { changes: number }; results: [] }> => ({
        success: true,
        meta: { changes: 1 },
        results: [],
      });
      return {
        bind: (...params: unknown[]) => {
          lastParams = params;
          return { run, all: run, first: run };
        },
        run: async () => run(),
        all: async () => run(),
        first: async () => null,
      };
    },
  };
  return { db, last: () => ({ sql: lastQuery, params: lastParams }) };
}

describe('NotificationDAO recipient predicate', () => {
  it('matches on the account id so an address change keeps the inbox', async () => {
    const cap = capture();
    const dao = new NotificationDAO(cap.db as never);
    await dao.listByUser({ userId: ALICE, userEmail: 'alice@new.test' }, 10, undefined, false);
    expect(cap.last().sql).toContain('(user_id = ? OR (user_id IS NULL AND user_email = ?))');
    // The caller's *current* address is the fallback, not the stored one.
    expect(cap.last().params.slice(0, 2)).toEqual([ALICE, 'alice@new.test']);
  });

  it('falls back to the address alone when no account id is available', async () => {
    const cap = capture();
    const dao = new NotificationDAO(cap.db as never);
    await dao.listByUser({ userId: null, userEmail: 'alice@old.test' }, 10, undefined, false);
    expect(cap.last().sql).toContain('user_email = ?');
    expect(cap.last().sql).not.toContain('user_id = ? OR');
    expect(cap.last().params[0]).toBe('alice@old.test');
  });

  it('applies the same ownership rule to every mutation', async () => {
    for (const call of [
      (dao: NotificationDAO) => dao.unreadCount({ userId: ALICE, userEmail: 'a@new.test' }),
      (dao: NotificationDAO) => dao.markRead('n1', { userId: ALICE, userEmail: 'a@new.test' }),
      (dao: NotificationDAO) => dao.markAllRead({ userId: ALICE, userEmail: 'a@new.test' }),
    ]) {
      const cap = capture();
      await call(new NotificationDAO(cap.db as never));
      expect(cap.last().sql).toContain('user_id = ? OR');
      expect(cap.last().params).toContain(ALICE);
    }
  });

  it('stores the account id alongside the denormalized address', async () => {
    const cap = capture();
    const dao = new NotificationDAO(cap.db as never);
    await dao.insert({
      id: 'n1',
      userEmail: 'alice@old.test',
      userId: ALICE,
      actorUserId: BOB,
      repositoryId: 'r1',
      actorEmail: 'bob@x.test',
      type: 'issue_commented',
      title: 'Hi',
      now: 100,
    });
    expect(cap.last().sql).toContain('user_id');
    expect(cap.last().sql).toContain('actor_user_id');
    // Legacy readers still get the address they always got.
    expect(cap.last().params).toContain('alice@old.test');
    expect(cap.last().params).toContain(ALICE);
  });
});

describe('NotificationService.fanOut', () => {
  it('stamps the recipient account and hands back ids for inbox fan-out', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const service = new NotificationService({ DB: {} } as never, {
      notificationDAO: async () => ({ insert: async (i: Record<string, unknown>) => void inserted.push(i) }) as never,
      watchDAO: async () => ({ listWatchers: async () => [] }) as never,
      userDAO: async () => ({ getByUsernameCi: async () => null }) as never,
      repositoryDAO: async () => ({ getById: async () => null }) as never,
      permissionService: async () => ({ getRole: async () => 'read' }) as never,
      userIdentity: async () =>
        ({ resolveUserId: async (email: string) => (email === 'alice@old.test' ? ALICE : null) }) as never,
    });

    const result = await service.fanOut({
      repositoryId: null,
      fullName: 'alice/demo',
      actorEmail: 'bob@x.test',
      type: 'issue_commented',
      title: 'Hi',
      participantEmails: ['alice@old.test'],
    });

    expect(result.notified).toBe(1);
    // The ids drive the realtime inbox shard, so they must be present for every
    // resolved recipient.
    expect(result.recipientUserIds).toEqual([ALICE]);
    expect(inserted[0]?.['userId']).toBe(ALICE);
    // The denormalized address copy is retained for legacy readers and FKs.
    expect(inserted[0]?.['userEmail']).toBe('alice@old.test');
  });

  it('still notifies an unresolvable recipient but omits them from live fan-out', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const service = new NotificationService({ DB: {} } as never, {
      notificationDAO: async () => ({ insert: async (i: Record<string, unknown>) => void inserted.push(i) }) as never,
      watchDAO: async () => ({ listWatchers: async () => [] }) as never,
      userDAO: async () => ({ getByUsernameCi: async () => null }) as never,
      repositoryDAO: async () => ({ getById: async () => null }) as never,
      permissionService: async () => ({ getRole: async () => 'read' }) as never,
      userIdentity: async () => ({ resolveUserId: async () => null }) as never,
    });

    const result = await service.fanOut({
      repositoryId: null,
      fullName: 'alice/demo',
      actorEmail: 'bob@x.test',
      type: 'issue_commented',
      title: 'Hi',
      participantEmails: ['ghost@x.test'],
    });

    // The notification is stored (the address is still a valid store key) but
    // there is no account to route a live update to.
    expect(result.notified).toBe(1);
    expect(result.recipientUserIds).toEqual([]);
    expect(inserted[0]?.['userId']).toBeNull();
  });
});

describe('RealtimeService inbox shard', () => {
  it('derives a stable, opaque tag from the account id', async () => {
    const hash = await RealtimeService.inboxHashForUserId(ALICE);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    // The raw id must not reach the shard name.
    expect(hash).not.toContain('usr_');
    // An unchanged account keeps its shard, so live subscriptions survive.
    expect(await RealtimeService.inboxHashForUserId(ALICE)).toBe(hash);
    // Distinct accounts never collide.
    expect(await RealtimeService.inboxHashForUserId(BOB)).not.toBe(hash);
  });

  it('dedupes and bounds recipient hashing', async () => {
    expect(await RealtimeService.hashRecipients([ALICE, ALICE, BOB])).toHaveLength(2);
    // Bounded: a huge fan-out cannot turn into unbounded hashing.
    expect(await RealtimeService.hashRecipients(Array.from({ length: 900 }, () => ALICE))).toHaveLength(1);
  });
});
