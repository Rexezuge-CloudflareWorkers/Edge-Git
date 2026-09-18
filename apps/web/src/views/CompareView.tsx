import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CompareResult } from '../types';
import { loadCompare } from '../services/repoService';
import { fetchUpgraded, useUpgradeFetchState } from '../lib/upgradeFetch';
import { RepoHeader, type RepoTab } from '../components/repo/RepoHeader';
import { DiffView } from '../components/repo/DiffView';
import { Card } from '../components/ui/Card';
import { AppPage } from '../components/layout/AppPage';
import { LoadingSpinner } from '../components/layout/PageState';
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

  const useAuthed = authorized === true;
  // Same-key auth-upgrade skip + in-flight sharing (see upgradeFetch).
  const upgradeStateRef = useUpgradeFetchState<CompareResult>();

  useEffect(() => {
    if (status !== 'ready' || !base || !head) return;
    const key = `${owner}/${repo}/${base}/${head}`;
    const authOpt = useAuthed ? { isAuthed: true as const } : { isAuthed: false as const };
    let cancelled = false;
    const run = async () => {
      let result;
      try {
        result = await fetchUpgraded(upgradeStateRef.current, key, () => loadCompare(owner, repo, base, head, authOpt));
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : '';
        if (message.includes('404') || message.includes('Not found')) {
          setMissing(true);
          return;
        }
        showNotice('error', message || t('errors.failedToLoadCompare', 'Failed To Load Comparison.'));
        return;
      }
      if (cancelled || result.status === 'skipped') return;
      setDiff(result.data);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, base, head, status, showNotice, t, useAuthed]);

  if (status === 'loading' && !repoData) {
    return <LoadingSpinner label="Loading repository" />;
  }

  if (status === 'missing') {
    return (
      <AppPage>
        <Card>
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">
            {t('repos.repositoryNotFound', 'Repository Not Found')}
          </h1>
        </Card>
      </AppPage>
    );
  }

  if (status === 'forbidden' || !repoData) {
    return (
      <AppPage>
        <Unauthorized message={t('repos.privateRepositoryMessage', 'This Repository Is Private. Sign In To View It.')} />
      </AppPage>
    );
  }

  const showHint = base === '' || head === '';

  return (
    <div>
      <RepoHeader
        repo={repoData}
        activeTab="code"
        showSettings={false}
        onTabChange={(id: RepoTab) => navigate(`/${owner}/${repo}${id === 'code' ? '' : `?tab=${id}`}`)}
      />
      <AppPage>
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
      </AppPage>
    </div>
  );
}
