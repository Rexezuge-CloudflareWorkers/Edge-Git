import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Repo } from '../types';
import { getBackendErrorStatus } from '../lib/api';
import { loadRepoAuthed, loadRepoPublic } from '../services/repoService';
import { RepoHeader, type RepoTab } from '../components/repo/RepoHeader';
import { ActivityTab } from '../components/repo/ActivityTab';
import { CodeTab } from '../components/repo/CodeTab';
import { DiscussionsTab } from '../components/repo/DiscussionsTab';
import { IssuesTab } from '../components/repo/IssuesTab';
import { ProjectsTab } from '../components/repo/ProjectsTab';
import { PullsTab } from '../components/repo/PullsTab';
import { ReleasesTab } from '../components/repo/ReleasesTab';
import { WikiTab } from '../components/repo/WikiTab';
import { RepoSettingsTab } from '../components/repo/RepoSettingsTab';
import { Card } from '../components/ui/Card';
import { AppPage } from '../components/layout/AppPage';
import { LoadingSpinner } from '../components/layout/PageState';
import { parseEnumParam, writeParams } from '../lib/urlParams';
import Unauthorized from '../components/layout/Unauthorized';

const REPO_TABS = ['code', 'pulls', 'issues', 'projects', 'discussions', 'wiki', 'releases', 'activity', 'settings'] as const;
// Params owned by individual tabs; cleared when switching tabs or repos so
// pasted URLs never leak stale branch/file/filter state into a new context.
const TAB_LOCAL_PARAMS = ['ref', 'path', 'blob', 'label', 'q', 'category', 'discussion'];

export function RepoView({
  authorized,
  showNotice,
  defaultOwner,
}: {
  authorized: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
  defaultOwner: string;
}) {
  const { owner = '', repo = '' } = useParams<{ owner: string; repo: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [repoData, setRepoData] = useState<Repo | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'forbidden'>('loading');
  const tab = parseEnumParam<RepoTab>(params.get('tab'), REPO_TABS, 'code');
  const setTab = (next: RepoTab) => {
    writeParams(setParams, params, { tab: next === 'code' ? '' : next, ...Object.fromEntries(TAB_LOCAL_PARAMS.map((k) => [k, ''])) });
  };
  // Navigating owner/repo keeps `tab` (deliberate) but drops tab-local
  // branch/file/filter params from the previous repository.
  const repoKey = `${owner}/${repo}`;
  const prevRepoKeyRef = useRef(repoKey);
  useEffect(() => {
    if (prevRepoKeyRef.current === repoKey) return;
    prevRepoKeyRef.current = repoKey;
    writeParams(setParams, params, Object.fromEntries(TAB_LOCAL_PARAMS.map((k) => [k, ''])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoKey]);
  const [issueCount, setIssueCount] = useState<number | undefined>(undefined);
  const [pullCount, setPullCount] = useState<number | undefined>(undefined);
  const [releaseCount, setReleaseCount] = useState<number | undefined>(undefined);

  // `true` only for signed-in viewers: `null` (resolving) and `false`
  // share the public path so null->false never refetches. A public 404
  // while resolving is parked in `pendingErrorRef` and applied when auth
  // settles without a second fetch (see effect below).
  const useAuthed = authorized === true;
  const pendingErrorRef = useRef<{ key: string; kind: 'missing' | 'forbidden' } | null>(null);

  useEffect(() => {
    pendingErrorRef.current = null;
    let cancelled = false;
    const run = async () => {
      // Speculative public load: never wait for Access auth to render public
      // repos. When auth resolves to true we upgrade to the authed payload
      // (viewerRole/viewerCanManage) via `useAuthed`.
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
        const status = getBackendErrorStatus(error);
        const kind = status === 404 ? 'missing' : 'forbidden';
        // Private repos 404 on public while auth is still resolving — stay in
        // loading until `authorized` settles instead of flashing Not Found.
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

  // Apply a parked public-load error once auth settles as anonymous, with no
  // refetch (null->false keeps `useAuthed` false so the loader above idles).
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
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('repos.repositoryNotFound', 'Repository Not Found')}</h1>
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

  const canManage = repoData?.viewerCanManage === true;
  const visibleTab: RepoTab = tab === 'settings' && !canManage ? 'code' : tab;

  return (
    <div>
      <RepoHeader
        repo={repoData}
        activeTab={visibleTab}
        issueCount={issueCount}
        pullCount={pullCount}
        releaseCount={releaseCount}
        forkCount={repoData.forksCount}
        showSettings={canManage}
        onTabChange={setTab}
      />
      <AppPage>
        {visibleTab === 'code' && (
          <CodeTab
            key={`${owner}/${repo}`}
            owner={owner}
            repo={repo}
            repoMeta={repoData}
            canFork={authorized ?? false}
            canWrite={repoData.viewerRole === 'admin' || repoData.viewerRole === 'write'}
            forkOwner={defaultOwner || owner}
            showNotice={showNotice}
            authorized={authorized}
          />
        )}
        {visibleTab === 'pulls' && (
          <PullsTab
            owner={owner}
            repo={repo}
            repoMeta={repoData}
            canWrite={authorized ?? false}
            showNotice={showNotice}
            onCountChange={setPullCount}
            authorized={authorized}
          />
        )}
        {visibleTab === 'issues' && (
          <IssuesTab
            owner={owner}
            repo={repo}
            canWrite={authorized ?? false}
            showNotice={showNotice}
            onCountChange={setIssueCount}
            authorized={authorized}
          />
        )}
        {visibleTab === 'projects' && (
          <ProjectsTab owner={owner} repo={repo} canWrite={authorized ?? false} showNotice={showNotice} authorized={authorized} />
        )}
        {visibleTab === 'discussions' && (
          <DiscussionsTab owner={owner} repo={repo} canWrite={authorized ?? false} showNotice={showNotice} authorized={authorized} />
        )}
        {visibleTab === 'wiki' && (
          <WikiTab
            owner={owner}
            repo={repo}
            canWrite={repoData.viewerRole === 'admin' || repoData.viewerRole === 'write'}
            showNotice={showNotice}
            authorized={authorized}
          />
        )}
        {visibleTab === 'releases' && (
          <ReleasesTab
            owner={owner}
            repo={repo}
            canWrite={authorized ?? false}
            showNotice={showNotice}
            onCountChange={setReleaseCount}
            authorized={authorized}
          />
        )}
        {visibleTab === 'activity' && <ActivityTab owner={owner} repo={repo} showNotice={showNotice} authorized={authorized} />}
        {visibleTab === 'settings' && (
          <RepoSettingsTab
            key={`${repoData.description ?? ''}:${repoData.isPrivate}`}
            owner={owner}
            repo={repo}
            repoMeta={repoData}
            showNotice={showNotice}
            onUpdated={setRepoData}
            onDeleted={() => navigate('/')}
          />
        )}
      </AppPage>
    </div>
  );
}
