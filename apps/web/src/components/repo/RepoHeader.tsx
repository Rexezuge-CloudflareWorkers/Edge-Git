import { Link } from 'react-router-dom';
import { BookMarked, GitFork } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Repo } from '../../types';
import { VisibilityBadge } from '../ui/Badge';
import { ContextBar } from '../layout/ContextBar';
import { SegmentedTabs } from '../layout/SegmentedTabs';

export type RepoTab = 'code' | 'pulls' | 'issues' | 'projects' | 'discussions' | 'wiki' | 'releases' | 'activity' | 'settings';

const TABS: Array<{ id: RepoTab; labelKey: string; fallback: string }> = [
  { id: 'code', labelKey: 'repos.code', fallback: 'Code' },
  { id: 'pulls', labelKey: 'pulls.pulls', fallback: 'Pull Requests' },
  { id: 'issues', labelKey: 'issues.issues', fallback: 'Issues' },
  { id: 'projects', labelKey: 'projects.projects', fallback: 'Projects' },
  { id: 'discussions', labelKey: 'discussions.discussions', fallback: 'Discussions' },
  { id: 'wiki', labelKey: 'wiki.wiki', fallback: 'Wiki' },
  { id: 'releases', labelKey: 'releases.releases', fallback: 'Releases' },
  { id: 'activity', labelKey: 'social.activity', fallback: 'Activity' },
  { id: 'settings', labelKey: 'repos.settings', fallback: 'Settings' },
];

export function RepoHeader({
  repo,
  activeTab,
  issueCount,
  pullCount,
  releaseCount,
  forkCount,
  showSettings,
  onTabChange,
}: {
  repo: Repo;
  activeTab: RepoTab;
  issueCount?: number;
  pullCount?: number;
  releaseCount?: number;
  forkCount?: number;
  showSettings?: boolean;
  onTabChange: (tab: RepoTab) => void;
}) {
  const { t } = useTranslation();
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
      />
      <div className="max-w-7xl mx-auto px-6 py-3">
        <SegmentedTabs
          ariaLabel={t('repos.sections', 'Repository Sections')}
          tabs={tabs.map((tab) => ({ id: tab.id, label: t(tab.labelKey, tab.fallback), count: counts[tab.id] }))}
          value={activeTab}
          onChange={(id) => onTabChange(id as RepoTab)}
        />
      </div>
    </div>
  );
}
