import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CommitDiffResult } from '../types';
import { loadCommit } from '../services/repoService';
import { fetchUpgraded, useUpgradeFetchState } from '../lib/upgradeFetch';
import { firstLine, formatCommitDate } from '../lib/format';
import { RepoHeader, type RepoTab } from '../components/repo/RepoHeader';
import { DiffView } from '../components/repo/DiffView';
import { Card } from '../components/ui/Card';
import { AppPage } from '../components/layout/AppPage';
import { LoadingSpinner } from '../components/layout/PageState';
import Unauthorized from '../components/layout/Unauthorized';
import { useRepoData } from '../hooks/useRepoData';

export function CommitView({
  authorized,
  showNotice,
}: {
  authorized: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { owner = '', repo = '', oid = '' } = useParams<{ owner: string; repo: string; oid: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { status, repoData } = useRepoData(owner, repo, authorized);
  const [diff, setDiff] = useState<CommitDiffResult | null>(null);
  const [missing, setMissing] = useState(false);

  const useAuthed = authorized === true;
  // Same-key auth-upgrade skip + in-flight sharing (see upgradeFetch). Keys
  // mark only on success, so a public 404 (private repo) still retries.
  const upgradeStateRef = useUpgradeFetchState<CommitDiffResult>();

  useEffect(() => {
    if (status !== 'ready') return;
    const key = `${owner}/${repo}/${oid}`;
    const authOpt = useAuthed ? { isAuthed: true as const } : { isAuthed: false as const };
    let cancelled = false;
    const run = async () => {
      let result;
      try {
        result = await fetchUpgraded(upgradeStateRef.current, key, () => loadCommit(owner, repo, oid, authOpt));
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : '';
        if (message.includes('404') || message.includes('Not found')) {
          setMissing(true);
          return;
        }
        showNotice('error', message || t('errors.failedToLoadCommit', 'Failed To Load Commit.'));
        return;
      }
      if (cancelled || result.status === 'skipped') return;
      if (!result.data.commit) {
        setMissing(true);
        return;
      }
      setDiff(result.data);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, oid, status, showNotice, t, useAuthed]);

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

  const commit = diff?.commit ?? null;

  return (
    <div>
      <RepoHeader repo={repoData} activeTab="code" showSettings={false} onTabChange={(id: RepoTab) => navigate(`/${owner}/${repo}${id === 'code' ? '' : `?tab=${id}`}`)} />
      <AppPage>
        <Link className="text-sm text-[var(--color-accent)] hover:underline" to={`/${owner}/${repo}/commits`}>
          {t('commits.backToHistory', 'Back To History')}
        </Link>
        {missing || (diff && !commit) ? (
          <Card>
            <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('commits.commitNotFound', 'Commit Not Found.')}</h1>
          </Card>
        ) : !diff || !commit ? (
          <div className="min-h-32 flex items-center justify-center">
            <div className="h-8 w-8 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
          </div>
        ) : (
          <>
            <Card>
              <p className="text-base font-medium text-[var(--color-text-primary)]">{firstLine(commit.commit.message)}</p>
              <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
                {commit.commit.author.name} · {formatCommitDate(commit.commit.author.timestamp, commit.commit.author.timezoneOffset)}
              </p>
              <code className="mt-2 block font-mono text-xs text-[var(--color-text-muted)] break-all">{commit.oid}</code>
              {commit.commit.message.includes('\n') && (
                <pre className="mt-3 whitespace-pre-wrap break-words text-sm text-[var(--color-text-secondary)]">
                  {commit.commit.message.split('\n').slice(1).join('\n').trim()}
                </pre>
              )}
            </Card>
            <DiffView files={diff.files} truncated={diff.truncated} />
          </>
        )}
      </AppPage>
    </div>
  );
}
