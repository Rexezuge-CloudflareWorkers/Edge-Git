import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GitBranch, Tag } from 'lucide-react';
import type { GitCommit, Repo, TagInfo } from '../../types';
import { formatTimestamp } from '../../lib/format';
import { formatDateLocale } from '../../lib/locale';
import { Card } from '../ui/Card';
import { Badge, VisibilityBadge } from '../ui/Badge';
import { RecentCommitsCard } from './RecentCommitsCard';
import { TagsCard } from './TagsCard';
import { ForkSyncButton } from './ForkSyncButton';

interface CodeTabSidebarProps {
  owner: string;
  repo: string;
  repoMeta: Repo;
  branches: string[];
  tags: TagInfo[];
  commits: GitCommit[];
  defaultBranch: string | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onSelectTag: (tagRef: string) => void;
}

// Sidebar facade: About card + recent commits + tags. Extracted from CodeTab
// so the tab stays under the god-file guard.
export function CodeTabSidebar(props: CodeTabSidebarProps) {
  const { t } = useTranslation();
  const { owner, repo, repoMeta, branches, tags, commits, defaultBranch, showNotice, onSelectTag } = props;
  return (
    <aside className="lg:col-span-1 space-y-4 min-w-0">
      <Card>
        <h2 className="text-base font-semibold text-[var(--color-text-primary)] mb-3">About</h2>
        {repoMeta.description ? (
          <p className="text-sm text-[var(--color-text-secondary)]">{repoMeta.description}</p>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)] italic">No description provided.</p>
        )}
        <div className="mt-3">
          <VisibilityBadge isPrivate={repoMeta.isPrivate} />
        </div>
        {repoMeta.forkedFrom && (
          <>
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">
              {t('forks.forkedFrom', 'Forked From')}{' '}
              <Link className="text-[var(--color-accent)] hover:underline font-mono" to={`/${repoMeta.forkedFrom}`}>
                {repoMeta.forkedFrom}
              </Link>
            </p>
            <div className="mt-2">
              <ForkSyncButton
                owner={owner}
                repo={repo}
                upstreamFull={repoMeta.forkedFrom}
                branch={defaultBranch ?? 'main'}
                showNotice={showNotice}
              />
            </div>
          </>
        )}
        <dl className="mt-4 space-y-2.5 text-sm">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
              <GitBranch className="h-3.5 w-3.5" />
              Branches
            </dt>
            <dd>
              <Badge variant="neutral">{branches.length}</Badge>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
              <Tag className="h-3.5 w-3.5" />
              {t('repos.tags', 'Tags')}
            </dt>
            <dd>
              <Badge variant="neutral">{tags.length}</Badge>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-[var(--color-text-muted)]">Default</dt>
            <dd className="font-mono text-xs text-[var(--color-text-primary)] truncate">{defaultBranch ?? '—'}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-[var(--color-text-muted)]">Created</dt>
            <dd className="text-xs text-[var(--color-text-secondary)]">{formatDateLocale(new Date(repoMeta.createdAt * 1000))}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-[var(--color-text-muted)]">Updated</dt>
            <dd className="text-xs text-[var(--color-text-secondary)]">{formatTimestamp(repoMeta.updatedAt)}</dd>
          </div>
        </dl>
      </Card>

      <RecentCommitsCard commits={commits} owner={owner} repo={repo} />

      <TagsCard tags={tags} onSelect={onSelectTag} />
    </aside>
  );
}
