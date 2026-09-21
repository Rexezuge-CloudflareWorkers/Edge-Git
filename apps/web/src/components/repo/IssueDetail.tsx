import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Comment, Issue } from '../../types';
import { addComment, getIssue, listComments, updateIssueStatus } from '../../services/issueService';
import { fetchUpgraded, useUpgradeFetchState } from '../../lib/upgradeFetch';
import { PresenceDots } from '../../realtime/PresenceDots';
import { issueChannel } from '../../realtime/protocol';
import { useRealtimeSubscription } from '../../realtime/useRealtime';
import { formatTimestamp } from '../../lib/format';
import { Markdown } from '../shared/Markdown';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Textarea } from '../ui/Input';
import { IssueStatusBadge } from '../ui/Badge';

export function IssueDetail({
  owner,
  repo,
  number,
  canWrite,
  canManage,
  showNotice,
  authorized,
}: {
  owner: string;
  repo: string;
  number: number;
  canWrite: boolean;
  canManage: boolean;
  showNotice: (type: 'success' | 'error', text: string) => void;
  authorized?: boolean | null;
}) {
  const { t } = useTranslation();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const useAuthed = authorized === true;
  const authOpt = useMemo(() => (useAuthed ? { isAuthed: true as const } : { isAuthed: false as const }), [useAuthed]);
  const lastTypingSent = useRef(0);

  const refreshComments = useCallback(async () => {
    try {
      setComments(await listComments(owner, repo, number, authOpt));
    } catch {
      // live refresh is best-effort; manual refresh still works
    }
  }, [owner, repo, number, authOpt]);

  const refreshIssue = useCallback(async () => {
    try {
      setIssue(await getIssue(owner, repo, number, authOpt));
    } catch {
      // best-effort
    }
  }, [owner, repo, number, authOpt]);

  const {
    status: liveStatus,
    viewers,
    typing,
    sendTyping,
  } = useRealtimeSubscription({
    enabled: useAuthed && status === 'ready',
    ticket: { kind: 'repo', owner, repo, channels: [issueChannel(number), 'presence'] },
    onEvent: (event) => {
      if (!event.type.startsWith('issue_')) return;
      void refreshComments();
      if (['issue_closed', 'issue_reopened', 'issue_updated'].includes(event.type)) {
        void refreshIssue();
      }
    },
  });
  // Single-flight reads across the auth upgrade (see upgradeFetch). Keyed
  // only on success, so a public 404 (private repo) still retries authed.
  // Post-mutation refreshes below bypass the helper and call services
  // directly, so new comments are never hidden by a stale key.
  const issueStateRef = useUpgradeFetchState<Issue>();
  const commentsStateRef = useUpgradeFetchState<Comment[]>();

  useEffect(() => {
    const key = `${owner}/${repo}/${number}`;
    let cancelled = false;
    const run = async () => {
      let issueRes;
      try {
        issueRes = await fetchUpgraded(issueStateRef.current, key, () => getIssue(owner, repo, number, authOpt));
      } catch {
        if (!cancelled) setStatus('missing');
        return;
      }
      if (cancelled) return;
      if (issueRes.status === 'loaded') {
        setIssue(issueRes.data);
        setStatus('ready');
      }
      let commentsRes;
      try {
        commentsRes = await fetchUpgraded(commentsStateRef.current, `${key}/comments`, () => listComments(owner, repo, number, authOpt));
      } catch (error) {
        if (!cancelled) {
          showNotice('error', error instanceof Error ? error.message : t('errors.failedToLoadComments', 'Failed To Load Comments.'));
        }
        return;
      }
      if (cancelled || commentsRes.status === 'skipped') return;
      setComments(commentsRes.data);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, number, showNotice, t, useAuthed, authOpt]);

  if (status === 'loading') {
    return (
      <div className="min-h-64 flex items-center justify-center">
        <div className="h-10 w-10 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
      </div>
    );
  }

  if (status === 'missing' || !issue) {
    return (
      <Card>
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('issues.issueNotFound', 'Issue Not Found.')}</h1>
      </Card>
    );
  }

  const toggleStatus = async () => {
    const next = issue.status === 'open' ? 'closed' : 'open';
    setToggling(true);
    try {
      const updated = await updateIssueStatus(owner, repo, number, next);
      setIssue(updated);
      showNotice('success', next === 'closed' ? t('issues.issueClosed', 'Issue Closed.') : t('issues.issueReopened', 'Issue Reopened.'));
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToUpdateIssue', 'Failed To Update Issue.'));
    } finally {
      setToggling(false);
    }
  };

  const submitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (draft.trim() === '') return;
    const body = draft.trim();
    setSaving(true);
    try {
      await addComment(owner, repo, number, { body });
      setDraft('');
      const list = await listComments(owner, repo, number);
      setComments(list);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToAddComment', 'Failed To Add Comment.'));
    } finally {
      setSaving(false);
    }
  };

  const handleDraftChange = (value: string) => {
    setDraft(value);
    // Throttled typing ping; visibility expires via timeout.
    const now = Date.now();
    if (liveStatus === 'live' && now - lastTypingSent.current > 4000) {
      lastTypingSent.current = now;
      sendTyping(issueChannel(number));
    }
  };

  return (
    <div className="space-y-4">
      <Link to={`/${owner}/${repo}`} className="text-sm text-[var(--color-accent)] hover:underline">
        {t('issues.backToIssues', 'Back To Issues')}
      </Link>

      <Card>
        <div className="flex items-center gap-2 flex-wrap">
          <IssueStatusBadge status={issue.status} />
          <span className="text-xs text-[var(--color-text-muted)]">#{issue.number}</span>
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{issue.title}</h1>
          <PresenceDots status={liveStatus} viewers={viewers} />
        </div>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          {t('issues.openedBy', 'Opened By {{email}} · {{date}}', {
            username: issue.creator,
            date: formatTimestamp(issue.created_at),
          })}
        </p>
        {issue.body && (
          <div className="mt-3 text-sm text-[var(--color-text-primary)]">
            <Markdown content={issue.body} />
          </div>
        )}
        {canManage && (
          <div className="mt-4">
            <Button type="button" variant="secondary" size="sm" loading={toggling} onClick={() => void toggleStatus()}>
              {issue.status === 'open' ? t('issues.closeIssue', 'Close Issue') : t('issues.reopenIssue', 'Reopen Issue')}
            </Button>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('issues.comments', 'Comments')}</CardTitle>
        </CardHeader>
        {comments.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">{t('issues.noComments', 'No Comments Yet.')}</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {comments.map((c) => (
              <li key={c.id} className="py-3 first:pt-0 last:pb-0">
                <p className="text-xs text-[var(--color-text-muted)]">
                  {t('issues.openedBy', 'Opened By {{email}} · {{date}}', {
                    username: c.author,
                    date: formatTimestamp(c.created_at),
                  })}
                </p>
                <div className="mt-1 text-sm text-[var(--color-text-primary)]">
                  <Markdown content={c.body} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {canWrite && (
          <form onSubmit={submitComment} className="mt-4 space-y-2">
            <Textarea
              placeholder={t('issues.commentPlaceholder', 'Write A Comment…')}
              value={draft}
              onChange={(e) => handleDraftChange(e.target.value)}
              rows={3}
            />
            {typing.length > 0 && (
              <p className="text-xs text-[var(--color-text-muted)]">
                {t('realtime.typing', '{{names}} Typing…', { names: typing.slice(0, 3).join(', ') })}
              </p>
            )}
            <p className="text-xs text-[var(--color-text-muted)]">{t('issues.markdownHint', 'Markdown Supported.')}</p>
            <Button type="submit" variant="primary" size="sm" loading={saving} disabled={draft.trim() === ''}>
              {t('issues.addComment', 'Add Comment')}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
