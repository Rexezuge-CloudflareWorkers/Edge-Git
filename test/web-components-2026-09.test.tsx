// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CodeTabToolbar } from '../apps/web/src/components/repo/CodeTabToolbar';
import { CodeTabSidebar } from '../apps/web/src/components/repo/CodeTabSidebar';
import { PullMergePanel } from '../apps/web/src/components/repo/PullMergePanel';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (_key: string, fallback?: string, opts?: Record<string, unknown>) => {
      let s = fallback ?? _key;
      if (opts) for (const [k, v] of Object.entries(opts)) s = s.replace(`{{${k}}}`, String(v));
      return s;
    },
  }),
}));

const socialStub = {
  watching: false,
  watchersCount: 3,
  starred: true,
  starsCount: 7,
  busy: null,
  toggleWatch: vi.fn(),
  toggleStar: vi.fn(),
} as never;

describe('CodeTabToolbar', () => {
  it('renders branch options and toolbar actions', () => {
    render(
      <MemoryRouter>
        <CodeTabToolbar
          owner="alice"
          repo="demo"
          branches={['main', 'dev']}
          defaultBranch="main"
          selectedRef="main"
          placeholderLabel="main"
          refParam=""
          path=""
          crumbs={[]}
          tags={[]}
          loading={false}
          editable={false}
          canWrite={false}
          forksCount={4}
          forkOwner="alice"
          authorized={false}
          social={socialStub}
          showNotice={() => undefined}
          navigateBrowser={() => undefined}
          setLoading={() => undefined}
          setBlobText={() => undefined}
          setBlobBinary={() => undefined}
          setReadme={() => undefined}
          setReloadKey={() => undefined}
          setCreateDir={() => undefined}
          onRefresh={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText('Branch')).toBeDefined();
    expect(screen.getByText('main')).toBeDefined();
    expect(screen.getByText('Fork')).toBeDefined();
    expect(screen.getByText('4')).toBeDefined();
  });
});

describe('CodeTabSidebar', () => {
  it('renders about card with counts', () => {
    render(
      <MemoryRouter>
        <CodeTabSidebar
          owner="alice"
          repo="demo"
          repoMeta={{ description: 'Demo repo', isPrivate: false, createdAt: 1_700_000_000, updatedAt: 1_700_000_100 } as never}
          branches={['main', 'dev']}
          tags={[]}
          commits={[]}
          defaultBranch="main"
          showNotice={() => undefined}
          onSelectTag={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('About')).toBeDefined();
    expect(screen.getByText('Demo repo')).toBeDefined();
  });
});

describe('PullMergePanel', () => {
  it('renders merge controls and blocked warning', () => {
    render(
      <MemoryRouter>
        <PullMergePanel
          owner="alice"
          repo="demo"
          pull={
            {
              status: 'open',
              head_oid: 'a'.repeat(40),
              head_branch: 'feat',
              base_branch: 'main',
              full_name: 'alice/demo',
              head_full_name: 'alice/demo',
            } as never
          }
          preview={{ alreadyMerged: false, canFastForward: true, mergeBase: 'b'.repeat(40) } as never}
          blockedByReview
          conflicts={[]}
          conflictReason={null}
          mergeMessage=""
          setMergeMessage={() => undefined}
          strategy="merge"
          setStrategy={() => undefined}
          deleteHead={false}
          setDeleteHead={() => undefined}
          merging={false}
          canManage
          authorized
          onMerge={() => undefined}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Merge Status')).toBeDefined();
    expect(screen.getByText('Blocked: Unresolved Change Requests.')).toBeDefined();
    expect(screen.getByText('Merge Pull Request')).toBeDefined();
  });
});
