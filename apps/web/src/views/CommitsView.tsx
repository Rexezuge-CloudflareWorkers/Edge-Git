import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { GitCommit } from '../types';
import { loadCommits } from '../services/repoService';
import { fetchUpgraded, useUpgradeFetchState } from '../lib/upgradeFetch';
import { firstLine, formatTimestamp } from '../lib/format';
import { readIntParam, writeParams } from '../lib/urlParams';
import { RepoHeader, type RepoTab } from '../components/repo/RepoHeader';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { AppPage } from '../components/layout/AppPage';
import { LoadingSpinner } from '../components/layout/PageState';
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
  const [params, setParams] = useSearchParams();
  const [commits, setCommits] = useState<GitCommit[]>([]);
  // List depth is URL state (`?depth=`) with the URL as the single source of
  // truth: "Load More" writes the query directly, so pasted links, Back, and
  // clicks can never disagree.
  const depth = readIntParam(params, 'depth', PAGE_DEPTH, 1);
  const setDepth = (next: number | ((d: number) => number)) => {
    const value = typeof next === 'function' ? next(depth) : next;
    writeParams(setParams, params, { depth: value === PAGE_DEPTH ? '' : String(value) });
  };
  const [loading, setLoading] = useState(true);
  const [exhausted, setExhausted] = useState(false);

  const useAuthed = authorized === true;
  // Single-flight reads across the auth upgrade (see upgradeFetch).
  const upgradeStateRef = useUpgradeFetchState<GitCommit[]>();

  useEffect(() => {
    if (status !== 'ready') return;
    const key = `${owner}/${repo}/${depth}`;
    const authOpt = useAuthed ? { isAuthed: true as const } : { isAuthed: false as const };
    let cancelled = false;
    const run = async () => {
      let result;
      try {
        result = await fetchUpgraded(upgradeStateRef.current, key, () => loadCommits(owner, repo, undefined, depth, authOpt));
      } catch (error) {
        if (!cancelled) {
          showNotice('error', error instanceof Error ? error.message : t('errors.failedToLoadCommits', 'Failed To Load Commits.'));
          setLoading(false);
        }
        return;
      }
      if (cancelled || result.status === 'skipped') return;
      const log = result.data;
      setCommits(log);
      if (log.length < depth) setExhausted(true);
      setLoading(false);
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, depth, status, showNotice, t, useAuthed]);

  if (status === 'loading' && !repoData) {
    return <LoadingSpinner label="Loading commits" />;
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

  return (
    <div>
      <RepoHeader
        repo={repoData}
        activeTab="code"
        showSettings={false}
        onTabChange={(id: RepoTab) => navigate(`/${owner}/${repo}${id === 'code' ? '' : `?tab=${id}`}`)}
      />
      <AppPage>
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
      </AppPage>
    </div>
  );
}
