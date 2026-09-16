import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Repo } from '../types';
import { loadRepoAuthed, loadRepoPublic } from '../services/repoService';
import { RepoHeader } from '../components/repo/RepoHeader';
import { PullDetail } from '../components/repo/PullDetail';
import { Card } from '../components/ui/Card';
import Unauthorized from '../components/layout/Unauthorized';

export function PullDetailView({
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

  const pullNumber = Number(number);

  const useAuthed = authorized === true;
  const pendingErrorRef = useRef<{ key: string; kind: 'missing' | 'forbidden' } | null>(null);

  useEffect(() => {
    pendingErrorRef.current = null;
    let cancelled = false;
    const run = async () => {
      if (useAuthed) {
        try {
          const data = await loadRepoAuthed(owner, repo);
          if (!cancelled) {
            setRepoData(data);
            setStatus('ready');
          }
          return;
        } catch {
          // Fall through to public.
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
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('repos.repositoryNotFound', 'Repository Not Found')}</h1>
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

  if (!Number.isSafeInteger(pullNumber)) {
    return (
      <div>
        <RepoHeader repo={repoData} activeTab="pulls" showSettings={false} onTabChange={() => navigate(`/${owner}/${repo}`)} />
        <div className="max-w-7xl mx-auto px-6 py-6">
          <Card>
            <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('pulls.pullNotFound', 'Pull Request Not Found.')}</h1>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div>
      <RepoHeader repo={repoData} activeTab="pulls" showSettings={false} onTabChange={() => navigate(`/${owner}/${repo}`)} />
      <div className="max-w-7xl mx-auto px-6 py-6">
        <PullDetail
          owner={owner}
          repo={repo}
          number={pullNumber}
          canWrite={authorized ?? false}
          canManage={repoData.viewerCanManage === true}
          showNotice={showNotice}
          authorized={authorized}
        />
      </div>
    </div>
  );
}
