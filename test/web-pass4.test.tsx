// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, def?: string) => def ?? _key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// lucide-react ships cosmetic class churn across versions (e.g. renamed
// icon aliases gain extra classes), which makes DOM snapshots flaky.
// Stub the icons used in this tree so snapshots pin our structure only.
// NOTE: components resolve the pnpm-nested `apps/web/node_modules`
// copy (1.41.0), not a root-level package — the mock must use the same
// relative path or it silently misses.
vi.mock('../apps/web/node_modules/lucide-react', () => {
  const Stub = (props: { className?: string }) => <svg data-testid="icon" className={props.className} />;
  return { Package: Stub, KanbanSquare: Stub, MessagesSquare: Stub, RefreshCw: Stub, Loader2: Stub };
});

// Markdown pulls the full micromark tree — orthogonal to these splits, so
// stub it to keep the jsdom graph light (same hermeticity rationale as the
// service mocks below).
vi.mock('../apps/web/src/components/shared/Markdown', () => ({
  Markdown: ({ content }: { content?: string }) => <div data-testid="markdown">{content ?? ''}</div>,
}));

vi.mock('../apps/web/src/services/releaseService', () => ({
  listReleases: vi.fn(async () => []),
  listReleaseAssets: vi.fn(async () => []),
  createRelease: vi.fn(async () => ({ release: { tagName: 'v1' } })),
  updateRelease: vi.fn(async () => ({})),
  deleteRelease: vi.fn(async () => ({})),
  deleteReleaseAsset: vi.fn(async () => ({})),
  uploadReleaseAsset: vi.fn(async () => ({})),
  releaseAssetDownloadUrl: (_o: string, _r: string, _t: string, id: string) => `/dl/${id}`,
}));

vi.mock('../apps/web/src/services/repoService', () => ({
  loadTags: vi.fn(async () => []),
}));

vi.mock('../apps/web/src/services/projectService', () => ({
  listProjects: vi.fn(async () => []),
  loadProjectBoard: vi.fn(async () => null),
  createProject: vi.fn(async () => ({ project: { number: 1 } })),
  createColumn: vi.fn(async () => ({})),
  createCard: vi.fn(async () => ({})),
  deleteCard: vi.fn(async () => ({})),
  deleteColumn: vi.fn(async () => ({})),
  moveCard: vi.fn(async () => ({})),
  renameColumn: vi.fn(async () => ({})),
  setCardArchived: vi.fn(async () => ({})),
  updateProject: vi.fn(async () => ({})),
}));

vi.mock('../apps/web/src/services/discussionService', () => ({
  listDiscussionCategories: vi.fn(async () => []),
  listDiscussions: vi.fn(async () => []),
  loadDiscussion: vi.fn(async () => null),
  createDiscussion: vi.fn(async () => ({ discussion: { number: 1 } })),
  addDiscussionComment: vi.fn(async () => ({})),
  deleteDiscussionComment: vi.fn(async () => ({})),
  deleteDiscussion: vi.fn(async () => ({})),
  updateDiscussion: vi.fn(async () => ({})),
}));

vi.mock('../apps/web/src/services/teamService', () => ({
  listTeams: vi.fn(async () => []),
  listTeamMembers: vi.fn(async () => []),
  listTeamRepos: vi.fn(async () => []),
  createTeam: vi.fn(async () => ({ slug: 't' })),
  deleteTeam: vi.fn(async () => ({})),
  addTeamMember: vi.fn(async () => ({})),
  removeTeamMember: vi.fn(async () => ({})),
  setTeamMemberRole: vi.fn(async () => ({})),
  grantTeamRepo: vi.fn(async () => ({})),
  revokeTeamRepo: vi.fn(async () => ({})),
}));

import { ReleaseRow } from '../apps/web/src/components/repo/ReleaseRow';
import { ReleasesTab } from '../apps/web/src/components/repo/ReleasesTab';
import { useReleases } from '../apps/web/src/components/repo/useReleases';
import { ProjectCardItem } from '../apps/web/src/components/repo/ProjectCardItem';
import { ProjectsTab } from '../apps/web/src/components/repo/ProjectsTab';
import { useProjects } from '../apps/web/src/components/repo/useProjects';
import { DiscussionsTab } from '../apps/web/src/components/repo/DiscussionsTab';
import { useDiscussions } from '../apps/web/src/components/repo/useDiscussions';
import { OrgTeamsManager } from '../apps/web/src/components/org/OrgTeamsManager';
import { useTeams } from '../apps/web/src/components/org/useTeams';
import { listReleases } from '../apps/web/src/services/releaseService';
import { listProjects } from '../apps/web/src/services/projectService';
import { listDiscussions } from '../apps/web/src/services/discussionService';
import { listTeams } from '../apps/web/src/services/teamService';

const notice = () => undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Pass-4 web splits: the refactored tabs render their empty states and the
 * extracted hooks drive the mocked services. Snapshots pin the
 * Container/Presenter structure (web stays out of V8 coverage by design).
 */
describe('pass4 web: releases split', () => {
  it('renders an empty releases tab', async () => {
    const { container } = render(<ReleasesTab owner="a" repo="b" canWrite={false} showNotice={notice} />);
    await waitFor(() => expect(listReleases).toHaveBeenCalled());
    expect(screen.getByText('No Releases Yet.')).toBeTruthy();
    expect(container.firstChild).toMatchSnapshot();
  });

  it('renders a draft release row with assets', async () => {
    const { listReleaseAssets } = await import('../apps/web/src/services/releaseService');
    vi.mocked(listReleaseAssets).mockResolvedValueOnce([{ id: 'a1', name: 'bin.tar.gz', size: 10 } as never]);
    render(
      <ReleaseRow
        owner="a"
        repo="b"
        release={{ id: 'r1', tagName: 'v1', name: '', isDraft: true, body: 'notes', createdBy: 'a@x.com', createdAt: 1 } as never}
        canWrite={false}
        showNotice={notice}
        onChanged={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByText('bin.tar.gz')).toBeTruthy());
    expect(screen.getByText('Draft')).toBeTruthy();
  });

  it('useReleases loads releases and tags', async () => {
    const { result } = renderHook(() => useReleases({ owner: 'a', repo: 'b', showNotice: notice }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(listReleases).toHaveBeenCalled();
    expect(result.current.releases).toEqual([]);
  });
});

describe('pass4 web: projects split', () => {
  it('renders an empty projects tab', async () => {
    const { container } = render(<ProjectsTab owner="a" repo="b" canWrite={false} showNotice={notice} />);
    await waitFor(() => expect(listProjects).toHaveBeenCalled());
    expect(screen.getByText('No Projects Yet.')).toBeTruthy();
    expect(container.firstChild).toMatchSnapshot();
  });

  it('renders a note card item', () => {
    const onArchive = vi.fn();
    render(
      <ProjectCardItem
        card={{ id: 'c1', kind: 'note', noteTitle: 'Todo', columnId: 'k1' } as never}
        columnTitles={[{ id: 'k2', title: 'Done' }]}
        onMove={() => undefined}
        onArchive={onArchive}
        onDelete={() => undefined}
        moveLabel={(t) => `→ ${t}`}
      />,
    );
    expect(screen.getByText('Todo')).toBeTruthy();
    screen.getByText('Archive').click();
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it('useProjects loads the list', async () => {
    const { result } = renderHook(() => useProjects({ owner: 'a', repo: 'b', showNotice: notice }));
    await waitFor(() => expect(listProjects).toHaveBeenCalled());
    expect(result.current.projects).toEqual([]);
  });
});

describe('pass4 web: discussions split', () => {
  it('renders an empty discussions tab inside a router', async () => {
    const { container } = render(
      <MemoryRouter>
        <DiscussionsTab owner="a" repo="b" canWrite={false} showNotice={notice} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(listDiscussions).toHaveBeenCalled());
    expect(screen.getByText('No Discussions Yet.')).toBeTruthy();
    expect(container.firstChild).toMatchSnapshot();
  });

  it('useDiscussions loads categories and discussions', async () => {
    const { result } = renderHook(() => useDiscussions({ owner: 'a', repo: 'b', category: '', showNotice: notice }), {
      wrapper: ({ children }: { children: React.ReactNode }) => <MemoryRouter>{children}</MemoryRouter>,
    });
    expect(result.current.discussions).toEqual([]);
    expect(result.current.loading).toBe(true);
  });
});

describe('pass4 web: teams split', () => {
  it('renders an empty teams manager', async () => {
    const { container } = render(<OrgTeamsManager org="acme" showNotice={notice} />);
    await waitFor(() => expect(listTeams).toHaveBeenCalled());
    expect(screen.getByText('No Teams Yet.')).toBeTruthy();
    expect(container.firstChild).toMatchSnapshot();
  });

  it('useTeams loads the list', async () => {
    const { result } = renderHook(() => useTeams({ org: 'acme', showNotice: notice }));
    await waitFor(() => expect(listTeams).toHaveBeenCalled());
    expect(result.current.teams).toEqual([]);
  });
});
