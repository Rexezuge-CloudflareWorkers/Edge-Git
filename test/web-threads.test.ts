import { describe, expect, it } from 'vitest';
import {
  countApprovals,
  countOpenThreads,
  groupThreadsByPath,
  isBlockedByCodeowners,
  isBlockedByReviews,
  latestReviewsByAuthor,
  threadLabel,
} from '../apps/web/src/lib/threads';

describe('web thread gate parity', () => {
  it('mirrors the API latest-wins gate and skips dismissed reviews', () => {
    expect(isBlockedByReviews([{ author_email: 'a@b.c', state: 'changes_requested' }])).toBe(true);
    expect(isBlockedByReviews([{ author_email: 'a@b.c', state: 'approved' }])).toBe(false);
    expect(isBlockedByReviews([{ author_email: 'a@b.c', state: 'changes_requested', dismissed: 1 }])).toBe(false);
    // Insertion order breaks same-second ties: last entry per author wins.
    expect(
      isBlockedByReviews([
        { author_email: 'a@b.c', state: 'changes_requested' },
        { author_email: 'a@b.c', state: 'approved' },
      ]),
    ).toBe(false);
    expect(latestReviewsByAuthor([{ author_email: 'A@b.c', state: 'approved' }]).has('a@b.c')).toBe(true);
  });

  it('counts approvals excluding the creator', () => {
    const reviews = [
      { author_email: 'bob@example.com', state: 'approved' },
      { author_email: 'alice@example.com', state: 'approved' },
    ];
    expect(countApprovals(reviews, 'alice@example.com')).toBe(1);
  });

  it('enforces the codeowner quorum like the API gate', () => {
    const reviews = [{ author_email: 'carol@example.com', state: 'approved' }];
    expect(isBlockedByCodeowners(reviews, 'alice@example.com', [])).toBe(false);
    expect(isBlockedByCodeowners(reviews, 'alice@example.com', ['carol@example.com'])).toBe(false);
    expect(isBlockedByCodeowners(reviews, 'alice@example.com', ['dave@example.com'])).toBe(true);
    expect(
      isBlockedByCodeowners([{ author_email: 'alice@example.com', state: 'approved' }], 'alice@example.com', ['alice@example.com']),
    ).toBe(true);
  });
});

describe('web thread grouping', () => {
  const threads = [
    { id: 't1', status: 'open', path: 'a.ts', line: 1, side: 'new' },
    { id: 't2', status: 'resolved', path: 'a.ts', line: null, side: 'new' },
    { id: 't3', status: 'open', path: 'b.ts', line: 9, side: 'old' },
  ] as Parameters<typeof groupThreadsByPath>[0];

  it('groups by path and counts open threads', () => {
    const groups = groupThreadsByPath(threads);
    expect(groups.get('a.ts')).toHaveLength(2);
    expect(groups.get('b.ts')).toHaveLength(1);
    expect(countOpenThreads(threads)).toBe(2);
  });

  it('labels threads with optional line and side', () => {
    expect(threadLabel({ path: 'a.ts', line: 12, side: 'new' })).toBe('a.ts:12 (new)');
    expect(threadLabel({ path: 'a.ts', line: null, side: 'new' })).toBe('a.ts');
  });
});
