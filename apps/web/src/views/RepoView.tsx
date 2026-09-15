import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { Repo } from '../types';
import { loadRepoAuthed, loadRepoPublic } from '../services/repoService';
import { RepoHeader, type RepoTab } from '../components/repo/RepoHeader';
import { CodeTab } from '../components/repo/CodeTab';
import { IssuesTab } from '../components/repo/IssuesTab';
import { TokensTab } from '../components/repo/TokensTab';
import { Card } from '../components/ui/Card';
import Unauthorized from '../components/layout/Unauthorized';

export function RepoView({
  authorized,
  showNotice,
}: {
  authorized: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { owner = '', repo = '' } = useParams<{ owner: string; repo: string }>();
  const [repoData, setRepoData] = useState<Repo | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'forbidden'>('loading');
  const [tab, setTab] = useState<RepoTab>('code');
  const [issueCount, setIssueCount] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (authorized === null) return;
    let cancelled = false;
    const run = async () => {
      // Authenticated first (own + shared repos), then anonymous public.
      if (authorized) {
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
        setStatus(message.includes('404') || message.includes('Not found') ? 'missing' : 'forbidden');
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, authorized]);

  if (status === 'loading' || authorized === null) {
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

  return (
    <div>
      <RepoHeader repo={repoData} activeTab={tab} issueCount={issueCount} onTabChange={setTab} />
      <div className="max-w-7xl mx-auto px-6 py-6">
        {tab === 'code' && <CodeTab owner={owner} repo={repo} showNotice={showNotice} />}
        {tab === 'issues' && (
          <IssuesTab owner={owner} repo={repo} canWrite={authorized ?? false} showNotice={showNotice} onCountChange={setIssueCount} />
        )}
        {tab === 'settings' &&
          (authorized ? <TokensTab showNotice={showNotice} /> : <Unauthorized message="Sign In To Manage Access Tokens." />)}
      </div>
    </div>
  );
}
