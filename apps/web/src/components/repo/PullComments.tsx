import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PullComment } from '../../types';
import { addPullComment, listPullComments } from '../../services/pullService';
import { formatTimestamp } from '../../lib/format';
import { Markdown } from '../shared/Markdown';
import { Button } from '../ui/Button';
import { CardHeader, CardTitle } from '../ui/Card';
import { Textarea } from '../ui/Input';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

export function PullComments({
  owner,
  repo,
  number,
  comments,
  onCommentsChange,
  canWrite,
  showNotice,
}: {
  owner: string;
  repo: string;
  number: number;
  comments: PullComment[];
  onCommentsChange: (comments: PullComment[]) => void;
  canWrite: boolean;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const submitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (draft.trim() === '') return;
    setSaving(true);
    try {
      await addPullComment(owner, repo, number, { body: draft.trim() });
      setDraft('');
      onCommentsChange(await listPullComments(owner, repo, number));
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToAddComment', 'Failed To Add Comment.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <CardHeader>
        <CardTitle>{t('pulls.comments', 'Comments')}</CardTitle>
      </CardHeader>
      {comments.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">{t('pulls.noComments', 'No Comments Yet.')}</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {comments.map((c) => (
            <li key={c.id} className="py-3 first:pt-0 last:pb-0">
              <p className="text-xs text-[var(--color-text-muted)]">
                {c.author} · {formatTimestamp(c.created_at)}
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
            placeholder={t('pulls.commentPlaceholder', 'Write A Comment…')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
          />
          <Button type="submit" variant="primary" size="sm" loading={saving} disabled={draft.trim() === ''}>
            {t('pulls.addComment', 'Add Comment')}
          </Button>
        </form>
      )}
    </div>
  );
}
