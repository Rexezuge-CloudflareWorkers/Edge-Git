import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import type { GitCommit } from '../../types';
import { firstLine, formatTimestamp } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';

export function RecentCommitsCard({ commits, owner, repo }: { commits: GitCommit[]; owner: string; repo: string }) {
  const { t } = useTranslation();
  const sidebarCommits = commits.slice(0, 5);
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-[var(--color-text-primary)] inline-flex items-center gap-1.5">
          <History className="h-4 w-4 text-[var(--color-text-muted)]" />
          {t('repos.recentCommits', 'Recent Commits')}
        </h2>
        <Badge variant="neutral">{commits.length}</Badge>
      </div>
      {sidebarCommits.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">{t('repos.noCommits', 'No Commits Yet.')}</p>
      ) : (
        <ul className="space-y-3">
          {sidebarCommits.map((c) => (
            <li key={c.oid} className="text-sm min-w-0">
              <Link className="text-[var(--color-text-primary)] hover:underline truncate block" to={`/${owner}/${repo}/commit/${c.oid}`}>
                {firstLine(c.commit.message)}
              </Link>
              <p className="text-xs text-[var(--color-text-muted)]">
                {c.commit.author.name} · {formatTimestamp(c.commit.author.timestamp)} ·{' '}
                <code className="font-mono">{c.oid.slice(0, 7)}</code>
              </p>
            </li>
          ))}
        </ul>
      )}
      {commits.length > 0 && (
        <Link className="mt-3 inline-block text-sm text-[var(--color-accent)] hover:underline" to={`/${owner}/${repo}/commits`}>
          {t('commits.viewAll', 'View All Commits')}
        </Link>
      )}
    </Card>
  );
}
