import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Comment, Issue } from '../../types';
import { addComment, getIssue, listComments, updateIssueStatus } from '../../services/issueService';
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
}: {
  owner: string;
  repo: string;
  number: number;
  canWrite: boolean;
  canManage: boolean;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { t } = useTranslation();
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const loaded = await getIssue(owner, repo, number);
        if (cancelled) return;
        setIssue(loaded);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('missing');
        return;
      }
      try {
        const list = await listComments(owner, repo, number);
        if (!cancelled) setComments(list);
      } catch (error) {
        if (!cancelled) {
          showNotice('error', error instanceof Error ? error.message : t('errors.failedToLoadComments', 'Failed To Load Comments.'));
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, number, showNotice, t]);

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
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">
          {t('issues.issueNotFound', 'Issue Not Found.')}
        </h1>
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
        </div>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          {t('issues.openedBy', 'Opened By {{email}} · {{date}}', {
            email: issue.creator_email,
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
                    email: c.author_email,
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
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
            />
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
