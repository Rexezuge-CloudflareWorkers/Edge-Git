import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { GitCommit } from '../types';
import { loadCommits } from '../services/repoService';
import { firstLine, formatTimestamp } from '../lib/format';
import { RepoHeader } from '../components/repo/RepoHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import Unauthorized from '../components/layout/Unauthorized';
import { useRepoData } from '../hooks/useRepoData';

const PAGE_DEPTH = 30;

export function CommitsView({
  authorized,
  showNotice,
}: {
  authorized: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { owner = '', repo = '' } = useParams<{ owner: string; repo: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { status, repoData } = useRepoData(owner, repo, authorized);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [depth, setDepth] = useState(PAGE_DEPTH);
  const [loading, setLoading] = useState(true);
  const [exhausted, setExhausted] = useState(false);

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    loadCommits(owner, repo, undefined, depth, authOpt)
      .then((log) => {
        if (cancelled) return;
        setCommits(log);
        if (log.length < depth) setExhausted(true);
      })
      .catch((error) => {
        if (!cancelled)
          showNotice('error', error instanceof Error ? error.message : t('errors.failedToLoadCommits', 'Failed To Load Commits.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [owner, repo, depth, status, showNotice, t, authorized]);

  if (status === 'loading' && !repoData) {
    return (
      <div className="min-h-64 flex items-center justify-center">
        <div className="h-10 w-10 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
      </div>
    );
  }

  if (status === 'missing') {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <Card>
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">
            {t('repos.repositoryNotFound', 'Repository Not Found')}
          </h1>
        </Card>
      </div>
    );
  }

  if (status === 'forbidden' || !repoData) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <Unauthorized message={t('repos.privateRepositoryMessage', 'This Repository Is Private. Sign In To View It.')} />
      </div>
    );
  }

  return (
    <div>
      <RepoHeader repo={repoData} activeTab="code" showSettings={false} onTabChange={() => navigate(`/${owner}/${repo}`)} />
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-4">
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('commits.history', 'Commit History')}</h1>
        <Card className="p-0 overflow-hidden">
          {!loading && commits.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)] p-5">{t('repos.noCommits', 'No Commits Yet.')}</p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {commits.map((c) => (
                <li key={c.oid} className="px-5 py-3 text-sm min-w-0">
                  <Link
                    className="text-[var(--color-text-primary)] hover:underline truncate block"
                    to={`/${owner}/${repo}/commit/${c.oid}`}
                  >
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
        </Card>
        {!exhausted && commits.length > 0 && (
          <Button
            onClick={() => {
              setLoading(true);
              setDepth((d) => d + PAGE_DEPTH);
            }}
            disabled={loading}
          >
            {t('common.loadMore', 'Load More')}
          </Button>
        )}
      </div>
    </div>
  );
}
