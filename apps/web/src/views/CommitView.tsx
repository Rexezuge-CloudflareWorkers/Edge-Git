import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { CommitDiffResult } from '../types';
import { loadCommit } from '../services/repoService';
import { firstLine, formatCommitDate } from '../lib/format';
import { RepoHeader } from '../components/repo/RepoHeader';
import { DiffView } from '../components/repo/DiffView';
import { Card } from '../components/ui/Card';
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
  const repoIsPrivate = repoData?.isPrivate === true;
  // Same-key auth-upgrade skip as CommitsView: public and authed diffs are
  // identical for servable repos. Only set on success with a commit, so a
  // public 404 (private repo) still retries authed.
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (status !== 'ready') return;
    const key = `${owner}/${repo}/${oid}`;
    if (useAuthed && !repoIsPrivate && loadedKeyRef.current === key) return;
    let cancelled = false;
    const authOpt = useAuthed ? { isAuthed: true as const } : { isAuthed: false as const };
    loadCommit(owner, repo, oid, authOpt)
      .then((d) => {
        if (cancelled) return;
        if (!d.commit) {
          setMissing(true);
          return;
        }
        loadedKeyRef.current = key;
        setDiff(d);
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : '';
        if (message.includes('404') || message.includes('Not found')) {
          setMissing(true);
          return;
        }
        showNotice('error', message || t('errors.failedToLoadCommit', 'Failed To Load Commit.'));
      });
    return () => {
      cancelled = true;
    };
  }, [owner, repo, oid, status, showNotice, t, useAuthed, repoIsPrivate]);

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

  const commit = diff?.commit ?? null;

  return (
    <div>
      <RepoHeader repo={repoData} activeTab="code" showSettings={false} onTabChange={() => navigate(`/${owner}/${repo}`)} />
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-4">
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
      </div>
    </div>
  );
}
