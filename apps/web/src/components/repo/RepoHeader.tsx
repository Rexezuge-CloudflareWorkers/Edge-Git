import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { BookMarked, GitFork } from 'lucide-react';
import type { Repo } from '../../types';
import { VisibilityBadge } from '../ui/Badge';
import { ContextBar } from '../layout/ContextBar';
import { SegmentedTabs } from '../layout/SegmentedTabs';

export type RepoTab = 'code' | 'pulls' | 'issues' | 'projects' | 'discussions' | 'wiki' | 'releases' | 'activity' | 'settings';

const TABS: Array<{ id: RepoTab; label: string }> = [
  { id: 'code', label: 'Code' },
  { id: 'pulls', label: 'Pulls' },
  { id: 'issues', label: 'Issues' },
  { id: 'projects', label: 'Projects' },
  { id: 'discussions', label: 'Discussions' },
  { id: 'wiki', label: 'Wiki' },
  { id: 'releases', label: 'Releases' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
];

export function RepoHeader({
  repo,
  activeTab,
  issueCount,
  pullCount,
  releaseCount,
  forkCount,
  showSettings,
  socialActions,
  onTabChange,
}: {
  repo: Repo;
  activeTab: RepoTab;
  issueCount?: number;
  pullCount?: number;
  releaseCount?: number;
  forkCount?: number;
  showSettings?: boolean;
  socialActions?: ReactNode;
  onTabChange: (tab: RepoTab) => void;
}) {
  const tabs = showSettings ? TABS : TABS.filter((t) => t.id !== 'settings');
  const counts: Partial<Record<RepoTab, number>> = {
    ...(issueCount !== undefined && { issues: issueCount }),
    ...(pullCount !== undefined && { pulls: pullCount }),
    ...(releaseCount !== undefined && { releases: releaseCount }),
  };
  return (
    <div className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-surface-1)]/95 backdrop-blur">
      <ContextBar
        bare
        crumb={
          <>
            <BookMarked className="h-5 w-5 text-[var(--color-text-muted)] shrink-0" />
            <h1 className="text-xl font-semibold text-[var(--color-text-primary)] truncate">
              <Link to={`/${repo.owner}`} className="text-[var(--color-accent)] hover:underline">
                {repo.owner}
              </Link>
              <span className="text-[var(--color-text-muted)] font-normal"> / </span>
              <Link
                to={`/${repo.owner}/${repo.name}`}
                onClick={() => onTabChange('code')}
                className="text-[var(--color-accent)] hover:underline"
              >
                {repo.name}
              </Link>
            </h1>
            <VisibilityBadge isPrivate={repo.isPrivate} />
            {forkCount !== undefined && forkCount > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                <GitFork className="h-3.5 w-3.5" />
                {forkCount}
              </span>
            )}
          </>
        }
        actions={socialActions}
      />
      <div className="max-w-7xl mx-auto px-6 py-3">
        <SegmentedTabs
          ariaLabel="Repository sections"
          tabs={tabs.map((t) => ({ id: t.id, label: t.label, count: counts[t.id] }))}
          value={activeTab}
          onChange={(id) => onTabChange(id as RepoTab)}
        />
      </div>
    </div>
  );
}
