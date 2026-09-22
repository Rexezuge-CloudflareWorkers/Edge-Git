import { describe, expect, it } from 'vitest';
import { CRON_TASK_FACTORIES, tasksForPhase } from '@edge-git/background/scheduled/TaskRegistry';
import { NotificationObserverRegistry } from '@edge-git/backend-services/notification';
import { ftsOrLike } from '@edge-git/backend-services/search';
import { countApprovals, matchRule, matchesPattern } from '@edge-git/backend-services/protection';
import { createExponentialRetryPolicy } from '@edge-git/backend-services/retry';
import { inboxTagsFor, buildChannelEnvelope } from '@edge-git/background/realtime/RealtimePublisher';
import { isRetryableImportStatus } from '@edge-git/background/transfer/RemoteImportClient';

describe('hardening patterns', () => {
  it('task factories are lazy and phase-split', () => {
    expect(CRON_TASK_FACTORIES.length).toBeGreaterThanOrEqual(10);
    expect(tasksForPhase(1).map((t) => t.name)).toEqual(['ExpiredTokenPruningTask']);
    const a = tasksForPhase(2);
    const b = tasksForPhase(2);
    expect(a.map((t) => t.name)).toEqual(b.map((t) => t.name));
    expect(a[0]).not.toBe(b[0]);
  });

  it('notification registry fans out best-effort', async () => {
    const seen: string[] = [];
    const registry = NotificationObserverRegistry.withObservers([
      async (e) => {
        seen.push(e.kind);
      },
      async () => {
        throw new Error('observer boom');
      },
    ]);
    await registry.emit({ kind: 'push' });
    expect(seen).toEqual(['push']);
    expect(registry.size).toBe(2);
  });

  it('ftsOrLike falls back to LIKE then []', async () => {
    const ok = await ftsOrLike(async () => [1], async () => [2], () => false);
    expect(ok).toEqual([1]);
    const fb = await ftsOrLike(
      async () => {
        throw new Error('no such table: fts');
      },
      async () => [2],
      (e) => /no such table/i.test(String((e as Error).message)),
    );
    expect(fb).toEqual([2]);
  });

  it('branch protection policy matches longest pattern and excludes self-approval', () => {
    expect(matchesPattern('main', 'main')).toBe(true);
    expect(matchesPattern('feat/*', 'feat/x')).toBe(true);
    const rules = [
      { pattern: '*' },
      { pattern: 'main' },
    ] as unknown as Parameters<typeof matchRule>[0];
    expect(matchRule(rules, 'main')?.pattern).toBe('main');
    expect(
      countApprovals(
        [
          { author_email: 'a@x.com', state: 'approved' },
          { author_email: 'creator@x.com', state: 'approved' },
        ],
        'creator@x.com',
      ),
    ).toBe(1);
  });

  it('retry policy classifies and backs off', () => {
    const policy = createExponentialRetryPolicy();
    expect(policy.isRetryable(429)).toBe(true);
    expect(policy.isRetryable(404)).toBe(false);
    expect(policy.backoffSeconds(1)).toBe(60);
    expect(policy.backoffSeconds(99)).toBe(86_400);
  });

  it('realtime publisher validates inbox tags and builds envelopes', () => {
    expect(inboxTagsFor({ channel: 'inbox:global', type: 'ping', recipientHashes: [123 as unknown as string] })).toEqual([]);
    const envelope = buildChannelEnvelope({ channel: 'activity', type: 'push' }, 'activity');
    expect(envelope?.channel).toBe('activity');
  });

  it('import retry classifier covers 429/5xx', () => {
    expect(isRetryableImportStatus(503)).toBe(true);
    expect(isRetryableImportStatus(404)).toBe(false);
  });
});
