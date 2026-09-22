import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Repo } from '../types';
import { loadRepoAuthed, loadRepoPublic } from '../services/repoService';
import { RepoHeader, type RepoTab } from '../components/repo/RepoHeader';
import { IssueDetail } from '../components/repo/IssueDetail';
import { Card } from '../components/ui/Card';
import { AppPage } from '../components/layout/AppPage';
import { LoadingSpinner } from '../components/layout/PageState';
import Unauthorized from '../components/layout/Unauthorized';
import { getBackendErrorStatus } from '../lib/api';

export function IssueDetailView({
  authorized,
  showNotice,
}: {
  authorized: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { owner = '', repo = '', number = '' } = useParams<{ owner: string; repo: string; number: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [repoData, setRepoData] = useState<Repo | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'forbidden'>('loading');

  const issueNumber = Number(number);

  const useAuthed = authorized === true;
  const pendingErrorRef = useRef<{ key: string; kind: 'missing' | 'forbidden' } | null>(null);

  useEffect(() => {
    pendingErrorRef.current = null;
    let cancelled = false;
    const run = async () => {
      // Speculative public load; upgrade to authed when `useAuthed` is true.
      if (useAuthed) {
        try {
          const data = await loadRepoAuthed(owner, repo);
          if (!cancelled) {
            setRepoData(data);
            setStatus('ready');
          }
          return;
        } catch {
          // Fall through to public — a 404 here may still be a public repo
          // when the viewer is logged out of Access in this browser.
        }
      }
      try {
        const data = await loadRepoPublic(owner, repo);
        if (!cancelled) {
          setRepoData(data);
          setStatus('ready');
        }
      } catch (error) {
        if (cancelled) return;
        const kind = getBackendErrorStatus(error) === 404 ? 'missing' : 'forbidden';
        if (authorized === null) {
          pendingErrorRef.current = { key: `${owner}/${repo}`, kind };
          return;
        }
        setStatus(kind);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, useAuthed]);

  useEffect(() => {
    if (authorized !== false || status !== 'loading' || repoData) return;
    const pending = pendingErrorRef.current;
    if (pending && pending.key === `${owner}/${repo}`) {
      setStatus(pending.kind);
      pendingErrorRef.current = null;
    }
  }, [authorized, status, repoData, owner, repo]);

  if (status === 'loading' && !repoData) {
    return <LoadingSpinner label={t('repos.loadingRepository', 'Loading Repository…')} />;
  }

  if (status === 'missing') {
    return (
      <AppPage>
        <Card>
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">
            {t('repos.repositoryNotFound', 'Repository Not Found')}
          </h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {t('repos.repositoryNotFoundDescription', '{{owner}}/{{repo}} Does Not Exist Or You Do Not Have Access To It.', {
              owner,
              repo,
            })}
          </p>
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

  if (!Number.isSafeInteger(issueNumber)) {
    return (
      <div>
        <RepoHeader
          repo={repoData}
          activeTab="issues"
          showSettings={false}
          onTabChange={(id: RepoTab) => navigate(`/${owner}/${repo}${id === 'code' ? '' : `?tab=${id}`}`)}
        />
        <AppPage>
          <Card>
            <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('issues.issueNotFound', 'Issue Not Found.')}</h1>
          </Card>
        </AppPage>
      </div>
    );
  }

  return (
    <div>
      <RepoHeader
        repo={repoData}
        activeTab="issues"
        showSettings={false}
        onTabChange={(id: RepoTab) => navigate(`/${owner}/${repo}${id === 'code' ? '' : `?tab=${id}`}`)}
      />
      <AppPage>
        <IssueDetail
          owner={owner}
          repo={repo}
          number={issueNumber}
          canWrite={authorized ?? false}
          canManage={repoData.viewerCanManage === true}
          showNotice={showNotice}
          authorized={authorized}
        />
      </AppPage>
    </div>
  );
}
