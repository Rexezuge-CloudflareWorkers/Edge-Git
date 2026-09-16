import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CompareResult } from '../types';
import { loadCompare } from '../services/repoService';
import { RepoHeader } from '../components/repo/RepoHeader';
import { DiffView } from '../components/repo/DiffView';
import { Card } from '../components/ui/Card';
import Unauthorized from '../components/layout/Unauthorized';
import { useRepoData } from '../hooks/useRepoData';

export function CompareView({
  authorized,
  showNotice,
}: {
  authorized: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { owner = '', repo = '' } = useParams<{ owner: string; repo: string }>();
  const [params] = useSearchParams();
  const base = params.get('base') ?? '';
  const head = params.get('head') ?? '';
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { status, repoData } = useRepoData(owner, repo, authorized);
  const [diff, setDiff] = useState<CompareResult | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (status !== 'ready' || !base || !head) return;
    let cancelled = false;
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    loadCompare(owner, repo, base, head, authOpt)
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : '';
        if (message.includes('404') || message.includes('Not found')) {
          setMissing(true);
          return;
        }
        showNotice('error', message || t('errors.failedToLoadCompare', 'Failed To Load Comparison.'));
      });
    return () => {
      cancelled = true;
    };
  }, [owner, repo, base, head, status, showNotice, t, authorized]);

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

  const showHint = base === '' || head === '';

  return (
    <div>
      <RepoHeader repo={repoData} activeTab="code" showSettings={false} onTabChange={() => navigate(`/${owner}/${repo}`)} />
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-4">
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">
          {t('commits.compare', 'Compare')} <code className="font-mono text-sm text-[var(--color-accent)]">{base || '…'}</code>
          <span className="text-[var(--color-text-muted)]"> … </span>
          <code className="font-mono text-sm text-[var(--color-accent)]">{head || '…'}</code>
        </h1>
        {showHint ? (
          <Card>
            <p className="text-sm text-[var(--color-text-secondary)]">
              {t('commits.compareHint', 'Provide Base And Head Refs, E.g. ?base=main&head=feature.')}
            </p>
            <Link className="mt-2 inline-block text-sm text-[var(--color-accent)] hover:underline" to={`/${owner}/${repo}`}>
              {t('repos.code', 'Code')}
            </Link>
          </Card>
        ) : missing ? (
          <Card>
            <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">
              {t('commits.compareNotFound', 'Comparison Not Found.')}
            </h1>
          </Card>
        ) : diff ? (
          <DiffView files={diff.files} truncated={diff.truncated} />
        ) : (
          <div className="min-h-32 flex items-center justify-center">
            <div className="h-8 w-8 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}
