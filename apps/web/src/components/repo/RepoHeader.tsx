import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { BookMarked, GitBranch, GitFork } from 'lucide-react';
import type { Repo } from '../../types';
import { VisibilityBadge } from '../ui/Badge';
import { cn } from '../../lib/utils';

export type RepoTab = 'code' | 'pulls' | 'issues' | 'activity' | 'settings';

const TABS: Array<{ id: RepoTab; label: string }> = [
  { id: 'code', label: 'Code' },
  { id: 'pulls', label: 'Pulls' },
  { id: 'issues', label: 'Issues' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
];

export function RepoHeader({
  repo,
  activeTab,
  issueCount,
  pullCount,
  forkCount,
  showSettings,
  socialActions,
  onTabChange,
}: {
  repo: Repo;
  activeTab: RepoTab;
  issueCount?: number;
  pullCount?: number;
  forkCount?: number;
  showSettings?: boolean;
  socialActions?: ReactNode;
  onTabChange: (tab: RepoTab) => void;
}) {
  const tabs = showSettings ? TABS : TABS.filter((t) => t.id !== 'settings');
  return (
    <div className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-surface-1)]/95 backdrop-blur">
      <div className="max-w-7xl mx-auto px-6 pt-6">
        <div className="flex items-center gap-3 flex-wrap">
          <Link to="/" aria-label="Edge-Git home" className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <GitBranch className="h-5 w-5 text-[var(--color-accent)]" />
            <span>
              <span className="text-[var(--color-accent)]">Edge</span>
              <span className="text-[var(--color-text-primary)]">-Git</span>
            </span>
          </Link>
          <span aria-hidden="true" className="text-[var(--color-text-muted)] font-normal">
            /
          </span>
          <BookMarked className="h-5 w-5 text-[var(--color-text-muted)]" />
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">
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
          {socialActions && <div className="ml-auto">{socialActions}</div>}
        </div>

        <nav className="flex items-center gap-0.5 mt-4">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onTabChange(t.id)}
              className={cn(
                'px-4 py-2 text-sm border-b-2 -mb-px transition-colors duration-150',
                activeTab === t.id
                  ? 'border-[var(--color-accent)] text-[var(--color-text-primary)] font-medium'
                  : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
              )}
            >
              {t.label}
              {t.id === 'issues' && issueCount !== undefined && (
                <span className="ml-1.5 text-xs text-[var(--color-text-muted)]">{issueCount}</span>
              )}
              {t.id === 'pulls' && pullCount !== undefined && (
                <span className="ml-1.5 text-xs text-[var(--color-text-muted)]">{pullCount}</span>
              )}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
