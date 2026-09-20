import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getPull, getPullDiff, getMergePreview, mergePull, updatePullStatus } from '../../services/pullService';
import { isBlockedByReviews } from '../../lib/threads';
import { PresenceDots } from '../../realtime/PresenceDots';
import { PullComments } from './PullComments';
import { PullReviews } from './PullReviews';
import { PullThreads } from './PullThreads';
import { formatTimestamp } from '../../lib/format';
import { Markdown } from '../shared/Markdown';
import { headLabel } from './PullsTab';
import { setPullDraft } from '../../services/collabService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Badge, PullStatusBadge } from '../ui/Badge';
import { usePullDetailData } from './usePullDetailData';
import { PullMergePanel } from './PullMergePanel';

export function PullDetail({
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
  const {
    pull,
    setPull,
    comments,
    setComments,
    reviews,
    setReviews,
    diff,
    setDiff,
    preview,
    setPreview,
    status,
    metaLabels,
    liveStatus,
    viewers,
    liveKey,
  } = usePullDetailData({ owner, repo, number, authorized });
  const [toggling, setToggling] = useState(false);
  const [merging, setMerging] = useState(false);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [conflictReason, setConflictReason] = useState<string | null>(null);
  const [mergeMessage, setMergeMessage] = useState('');
  const [deleteHead, setDeleteHead] = useState(false);
  const [strategy, setStrategy] = useState<'merge' | 'squash' | 'rebase'>('merge');

  if (status === 'loading') {
    return (
      <div className="min-h-64 flex items-center justify-center">
        <div className="h-10 w-10 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
      </div>
    );
  }

  if (status === 'missing' || !pull) {
    return (
      <Card>
        <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('pulls.pullNotFound', 'Pull Request Not Found.')}</h1>
      </Card>
    );
  }

  // Mirrors the API rule: a reviewer's latest non-dismissed review wins; any
  // outstanding changes_requested blocks the merge button.
  const blockedByReview = isBlockedByReviews(reviews);

  const toggleStatus = async () => {
    const next = pull.status === 'open' ? 'closed' : 'open';
    setToggling(true);
    try {
      const updated = await updatePullStatus(owner, repo, number, next);
      setPull(updated);
      showNotice(
        'success',
        next === 'closed' ? t('pulls.pullClosed', 'Pull Request Closed.') : t('pulls.pullReopened', 'Pull Request Reopened.'),
      );
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToUpdatePull', 'Failed To Update Pull Request.'));
    } finally {
      setToggling(false);
    }
  };

  const doMerge = async () => {
    setMerging(true);
    setConflicts([]);
    setConflictReason(null);
    try {
      const result = await mergePull(owner, repo, number, {
        message: mergeMessage.trim() || undefined,
        deleteHead,
        strategy,
      });
      setPull(result.pull);
      showNotice('success', t('pulls.pullMerged', 'Pull Request Merged.'));
      try {
        const [d, p] = await Promise.all([
          getPullDiff(owner, repo, number).catch(() => null),
          getMergePreview(owner, repo, number).catch(() => null),
        ]);
        if (d) setDiff(d);
        setPreview(p);
      } catch {
        // Best-effort refresh after merge.
      }
    } catch (error) {
      const raw = error instanceof Error ? error.message : '';
      try {
        const parsed = JSON.parse(raw) as { error?: string; conflicts?: string[]; reason?: string | null };
        if (Array.isArray(parsed.conflicts) || parsed.reason) {
          setConflicts(parsed.conflicts ?? []);
          setConflictReason(parsed.reason ?? null);
          showNotice('error', t('pulls.mergeConflicts', 'Merge Conflicts. Resolve Them On Your Branch.'));
          return;
        }
        showNotice('error', parsed.error || t('errors.failedToMergePull', 'Failed To Merge Pull Request.'));
      } catch {
        showNotice('error', raw || t('errors.failedToMergePull', 'Failed To Merge Pull Request.'));
      }
    } finally {
      setMerging(false);
    }
  };

  return (
    <div className="space-y-4">
      <Link to={`/${owner}/${repo}`} className="text-sm text-[var(--color-accent)] hover:underline">
        {t('pulls.backToPulls', 'Back To Pull Requests')}
      </Link>

      <Card>
        <div className="flex items-center gap-2 flex-wrap">
          <PullStatusBadge status={pull.status} />
          {(pull as { is_draft?: number }).is_draft === 1 && <Badge variant="warning">{t('pulls.draft', 'Draft')}</Badge>}
          <span className="text-xs text-[var(--color-text-muted)]">#{pull.number}</span>
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{pull.title}</h1>
          <PresenceDots status={liveStatus} viewers={viewers} />
        </div>
        {metaLabels.length > 0 && (
          <div className="mt-2 flex gap-1 flex-wrap">
            {metaLabels.map((l) => (
              <Badge key={l.name} variant="neutral">
                {l.name}
              </Badge>
            ))}
          </div>
        )}
        <p className="mt-1 text-xs text-[var(--color-text-muted)] font-mono">
          {pull.base_branch} ← {headLabel(pull)}
        </p>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          {t('pulls.openedBy', 'Opened By {{email}} · {{date}}', {
            email: pull.creator_email,
            date: formatTimestamp(pull.created_at),
          })}
        </p>
        {pull.body && (
          <div className="mt-3 text-sm text-[var(--color-text-primary)]">
            <Markdown content={pull.body} />
          </div>
        )}
        {canManage && pull.status !== 'merged' && (
          <div className="mt-4 flex gap-2 flex-wrap">
            <Button type="button" variant="secondary" size="sm" loading={toggling} onClick={() => void toggleStatus()}>
              {pull.status === 'open' ? t('pulls.closePull', 'Close Pull Request') : t('pulls.reopenPull', 'Reopen Pull Request')}
            </Button>
            {pull.status === 'open' && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  const next = (pull as { is_draft?: number }).is_draft !== 1;
                  void setPullDraft(owner, repo, number, next)
                    .then(() =>
                      getPull(owner, repo, number, { isAuthed: true })
                        .then(setPull)
                        .catch(() => undefined),
                    )
                    .catch((error) => showNotice('error', error instanceof Error ? error.message : 'Failed To Update Draft.'));
                }}
              >
                {(pull as { is_draft?: number }).is_draft === 1
                  ? t('pulls.markReady', 'Mark Ready For Review')
                  : t('pulls.markDraft', 'Mark As Draft')}
              </Button>
            )}
          </div>
        )}
      </Card>

      <PullMergePanel
        owner={owner}
        repo={repo}
        pull={pull}
        preview={preview}
        blockedByReview={blockedByReview}
        conflicts={conflicts}
        conflictReason={conflictReason}
        mergeMessage={mergeMessage}
        setMergeMessage={setMergeMessage}
        strategy={strategy}
        setStrategy={setStrategy}
        deleteHead={deleteHead}
        setDeleteHead={setDeleteHead}
        merging={merging}
        canManage={canManage}
        authorized={authorized}
        onMerge={() => void doMerge()}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t('pulls.diff', 'Diff')}</CardTitle>
          {diff?.truncated && <Badge variant="warning">{t('pulls.truncated', 'Truncated')}</Badge>}
        </CardHeader>
        {!diff || diff.changes.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">{t('pulls.noChanges', 'No Changes.')}</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {diff.changes.map((c) => (
              <li key={c.path} className="py-2 text-sm flex items-center gap-2">
                <Badge variant={c.type === 'add' ? 'success' : c.type === 'remove' ? 'error' : 'info'}>{c.type}</Badge>
                <span className="font-mono text-[var(--color-text-primary)]">{c.path}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <PullReviews
          owner={owner}
          repo={repo}
          number={number}
          reviews={reviews}
          onReviewsChange={setReviews}
          canWrite={canWrite}
          canManage={canManage}
          isOpen={pull.status === 'open'}
          showNotice={showNotice}
          authorized={authorized}
        />
      </Card>

      <Card>
        <PullThreads
          owner={owner}
          repo={repo}
          number={number}
          canWrite={canWrite}
          showNotice={showNotice}
          authorized={authorized}
          refreshKey={liveKey}
        />
      </Card>

      <Card>
        <PullComments
          owner={owner}
          repo={repo}
          number={number}
          comments={comments}
          onCommentsChange={setComments}
          canWrite={canWrite}
          showNotice={showNotice}
        />
      </Card>
    </div>
  );
}
