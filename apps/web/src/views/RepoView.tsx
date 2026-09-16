import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Repo } from '../types';
import { loadRepoAuthed, loadRepoPublic } from '../services/repoService';
import { RepoHeader, type RepoTab } from '../components/repo/RepoHeader';
import { CodeTab } from '../components/repo/CodeTab';
import { IssuesTab } from '../components/repo/IssuesTab';
import { PullsTab } from '../components/repo/PullsTab';
import { RepoSettingsTab } from '../components/repo/RepoSettingsTab';
import { Card } from '../components/ui/Card';
import Unauthorized from '../components/layout/Unauthorized';

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
  const navigate = useNavigate();
  const [repoData, setRepoData] = useState<Repo | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'forbidden'>('loading');
  const [tab, setTab] = useState<RepoTab>('code');
  const [issueCount, setIssueCount] = useState<number | undefined>(undefined);
  const [pullCount, setPullCount] = useState<number | undefined>(undefined);

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
        const message = error instanceof Error ? error.message : '';
        const kind = message.includes('404') || message.includes('Not found') ? 'missing' : 'forbidden';
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
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Repository Not Found</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {owner}/{repo} does not exist or you do not have access to it.
          </p>
        </Card>
      </div>
    );
  }

  if (status === 'forbidden' || !repoData) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <Unauthorized message="This Repository Is Private. Sign In To View It." />
      </div>
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
        forkCount={repoData.forksCount}
        showSettings={canManage}
        onTabChange={setTab}
      />
      <div className="max-w-7xl mx-auto px-6 py-6">
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
          <PullsTab owner={owner} repo={repo} repoMeta={repoData} canWrite={authorized ?? false} showNotice={showNotice} onCountChange={setPullCount} />
        )}
        {visibleTab === 'issues' && (
          <IssuesTab owner={owner} repo={repo} canWrite={authorized ?? false} showNotice={showNotice} onCountChange={setIssueCount} />
        )}
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
      </div>
    </div>
  );
}
