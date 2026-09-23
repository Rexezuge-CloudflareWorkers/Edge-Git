// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k, i18n: { language: 'en' } }),
  };
});

import { Card, CardHeader, CardTitle } from '../apps/web/src/components/ui/Card';
import { Badge } from '../apps/web/src/components/ui/Badge';
import { Button } from '../apps/web/src/components/ui/Button';
import { LoadingSpinner, EmptyState } from '../apps/web/src/components/layout/PageState';
import { LandingView } from '../apps/web/src/views/LandingView';
import { formatTimestamp, formatExpiryTimestamp, formatBytes, firstLine } from '../apps/web/src/lib/format';
import { buildQuery } from '../apps/web/src/lib/api';
import { isBlockedByReviews, countApprovals, groupThreadsByPath, countOpenThreads } from '../apps/web/src/lib/threads';

describe('harden sweep SPA: primitives', () => {
  it('Card renders Title Case chrome', () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Create Repository</CardTitle>
        </CardHeader>
      </Card>,
    );
    expect(screen.getByText('Create Repository')).toBeTruthy();
  });

  it('Badge and Button render variants', () => {
    const { container } = render(
      <div>
        <Badge>Public</Badge>
        <Button variant="primary">Sign In</Button>
      </div>,
    );
    expect(screen.getByText('Public')).toBeTruthy();
    expect(screen.getByText('Sign In')).toBeTruthy();
    expect(container.querySelector('button')).toBeTruthy();
  });

  it('PageState loading and empty render accessibly', () => {
    render(<LoadingSpinner label="Loading Repositories" />);
    expect(screen.getByRole('status', { name: 'Loading Repositories' })).toBeTruthy();
    render(<EmptyState message="No Issues Found" />);
    expect(screen.getByText('No Issues Found')).toBeTruthy();
  });

  it('LandingView renders hero Title Case copy', () => {
    render(<LandingView />);
    expect(screen.getByText('Self-Hosted Git On Cloudflare Workers')).toBeTruthy();
    expect(screen.getByText('Sign In With Cloudflare Access')).toBeTruthy();
  });
});

describe('harden sweep SPA: pure helpers parity', () => {
  it('format helpers handle nulls and bytes', () => {
    expect(formatTimestamp(null)).toBe('Never');
    expect(formatExpiryTimestamp(undefined)).toBe('Never');
    expect(formatBytes(2048)).toContain('KB');
    expect(firstLine('a\nb')).toBe('a');
  });

  it('buildQuery skips empty values', () => {
    expect(buildQuery({ q: 'x', empty: '' })).toBe('q=x');
    expect(buildQuery({})).toBe('');
  });

  it('threads gate parity: blocked, approvals, grouping', () => {
    const reviews = [
      { authorEmail: 'a@x.com', state: 'approved' as const, dismissed: false },
      { authorEmail: 'b@x.com', state: 'changes_requested' as const, dismissed: false },
    ];
    expect(isBlockedByReviews(reviews)).toBe(true);
    expect(countApprovals([{ authorEmail: 'b@x.com', state: 'approved' as const, dismissed: false }], 'a@x.com')).toBe(1);
    const threads = [
      {
        id: '1',
        path: 'a.ts',
        status: 'open' as const,
        line: 1,
        side: 'RIGHT' as const,
        authorEmail: 'a@x.com',
        body: 'x',
        createdAt: 1,
        replies: [],
      },
      {
        id: '2',
        path: 'a.ts',
        status: 'resolved' as const,
        line: 2,
        side: 'RIGHT' as const,
        authorEmail: 'a@x.com',
        body: 'y',
        createdAt: 2,
        replies: [],
      },
    ];
    expect(groupThreadsByPath(threads).get('a.ts')).toHaveLength(2);
    expect(countOpenThreads(threads)).toBe(1);
  });
});
