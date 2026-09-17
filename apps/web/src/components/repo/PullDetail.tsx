import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { MergePreview, PullComment, PullDiff, PullRequest, PullReview } from '../../types';
import {
  getMergePreview,
  getPull,
  getPullDiff,
  listPullComments,
  listPullReviews,
  mergePull,
  updatePullStatus,
} from '../../services/pullService';
import { isBlockedByReviews } from '../../lib/threads';
import { PullChecks } from './PullChecks';
import { PullComments } from './PullComments';
import { PullReviews } from './PullReviews';
import { PullThreads } from './PullThreads';
import { fetchUpgraded, useUpgradeFetchState } from '../../lib/upgradeFetch';
import { formatTimestamp } from '../../lib/format';
import { Markdown } from '../shared/Markdown';
import { headLabel } from './PullsTab';
import { getPullMeta, setPullDraft } from '../../services/collabService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Select, Textarea } from '../ui/Input';
import { Badge, PullStatusBadge } from '../ui/Badge';

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
  const [pull, setPull] = useState<PullRequest | null>(null);
  const [comments, setComments] = useState<PullComment[]>([]);
  const [reviews, setReviews] = useState<PullReview[]>([]);
  const [diff, setDiff] = useState<PullDiff | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [toggling, setToggling] = useState(false);
  const [merging, setMerging] = useState(false);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [conflictReason, setConflictReason] = useState<string | null>(null);
  const [mergeMessage, setMergeMessage] = useState('');
  const [deleteHead, setDeleteHead] = useState(false);
  const [strategy, setStrategy] = useState<'merge' | 'squash' | 'rebase'>('merge');
  const [metaLabels, setMetaLabels] = useState<Array<{ name: string }>>([]);

  const useAuthed = authorized === true;
  // Single-flight reads across the auth upgrade (see upgradeFetch). Keys are
  // marked only on success, so a public 404 (private repo) still retries
  // authed. Post-mutation refreshes below bypass the helper and call services
  // directly.
  const pullStateRef = useUpgradeFetchState<PullRequest>();
  const commentsStateRef = useUpgradeFetchState<PullComment[]>();
  const reviewsStateRef = useUpgradeFetchState<PullReview[]>();
  const diffStateRef = useUpgradeFetchState<PullDiff | null>();
  const previewStateRef = useUpgradeFetchState<MergePreview | null>();

  useEffect(() => {
    const key = `${owner}/${repo}/${number}`;
    const authOpt = useAuthed ? { isAuthed: true as const } : { isAuthed: false as const };
    let cancelled = false;
    const run = async () => {
      let pullRes;
      try {
        pullRes = await fetchUpgraded(pullStateRef.current, key, () => getPull(owner, repo, number, authOpt));
      } catch {
        if (!cancelled) setStatus('missing');
        return;
      }
      if (cancelled) return;
      if (pullRes.status === 'loaded') {
        setPull(pullRes.data);
        setStatus('ready');
      }      const [c, r, d] = await Promise.all([
        fetchUpgraded(commentsStateRef.current, `${key}/comments`, () => listPullComments(owner, repo, number, authOpt))
          .then((res) => (res.status === 'loaded' ? res.data : null))
          .catch(() => [] as PullComment[]),
        fetchUpgraded(reviewsStateRef.current, `${key}/reviews`, () => listPullReviews(owner, repo, number, authOpt))
          .then((res) => (res.status === 'loaded' ? res.data : null))
          .catch(() => [] as PullReview[]),
        fetchUpgraded(diffStateRef.current, `${key}/diff`, () => getPullDiff(owner, repo, number, authOpt))
          .then((res) => (res.status === 'loaded' ? res.data : null))
          .catch(() => null),
      ]);
      if (cancelled) return;
      if (c) setComments(c);
      if (r) setReviews(r);
      if (d) setDiff(d);
      try {
        const previewRes = await fetchUpgraded(previewStateRef.current, `${key}/preview`, () =>
          getMergePreview(owner, repo, number, authOpt),
        );
        if (!cancelled && previewRes.status === 'loaded') setPreview(previewRes.data);
      } catch {
        // preview is best-effort
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, number, useAuthed]);

  useEffect(() => {
    if (!useAuthed) return;
    let cancelled = false;
    void getPullMeta(owner, repo, number).then((meta) => {
      if (!cancelled) setMetaLabels(meta.labels ?? []);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [owner, repo, number, useAuthed]);

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
      showNotice('success', next === 'closed' ? t('pulls.pullClosed', 'Pull Request Closed.') : t('pulls.pullReopened', 'Pull Request Reopened.'));
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
        const [d, p] = await Promise.all([getPullDiff(owner, repo, number).catch(() => null), getMergePreview(owner, repo, number).catch(() => null)]);
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
        </div>
        {metaLabels.length > 0 && (
          <div className="mt-2 flex gap-1 flex-wrap">
            {metaLabels.map((l) => (
              <Badge key={l.name} variant="neutral">{l.name}</Badge>
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
                    .then(() => getPull(owner, repo, number, { isAuthed: true }).then(setPull).catch(() => undefined))
                    .catch((error) => showNotice('error', error instanceof Error ? error.message : 'Failed To Update Draft.'));
                }}
              >
                {(pull as { is_draft?: number }).is_draft === 1 ? t('pulls.markReady', 'Mark Ready For Review') : t('pulls.markDraft', 'Mark As Draft')}
              </Button>
            )}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('pulls.mergeStatus', 'Merge Status')}</CardTitle>
        </CardHeader>
        {preview ? (
          <div className="space-y-2 text-sm">
            <p className="text-[var(--color-text-secondary)]">
              {preview.alreadyMerged
                ? t('pulls.alreadyMerged', 'Branches Are Already Merged.')
                : preview.canFastForward
                  ? t('pulls.canFastForward', 'Can Be Fast-Forward Merged.')
                  : t('pulls.needsMergeCommit', 'Requires A Merge Commit.')}
            </p>
            {preview.mergeBase && (
              <p className="text-xs text-[var(--color-text-muted)] font-mono">
                {t('pulls.mergeBase', 'Merge Base: {{oid}}', { oid: preview.mergeBase.slice(0, 7) })}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">{t('pulls.previewUnavailable', 'Merge Preview Unavailable.')}</p>
        )}
        {blockedByReview && (
          <p className="mt-2 text-sm text-[var(--color-error-text)]">{t('pulls.blockedByReview', 'Blocked: Unresolved Change Requests.')}</p>
        )}
        <PullChecks owner={owner} repo={repo} headOid={pull.head_oid} />
        {(conflicts.length > 0 || conflictReason) && (
          <div className="mt-2 text-sm text-[var(--color-error-text)]">
            <p>{t('pulls.mergeConflicts', 'Merge Conflicts. Resolve Them On Your Branch.')}</p>
            {conflictReason && <p className="mt-1">{conflictReason}</p>}
            {conflicts.length > 0 && (
              <ul className="mt-1">
                {conflicts.map((f) => (
                  <li key={f} className="font-mono">
                    {f}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {canManage && pull.status === 'open' && (
          <div className="mt-3 space-y-2">
            <Textarea
              placeholder={t('pulls.mergeMessagePlaceholder', 'Merge Message (Optional)')}
              value={mergeMessage}
              onChange={(e) => setMergeMessage(e.target.value)}
              rows={2}
            />
            <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
              <span>{t('pulls.strategy', 'Strategy')}</span>
              <Select value={strategy} onChange={(e) => setStrategy(e.target.value as 'merge' | 'squash' | 'rebase')}>
                <option value="merge">merge</option>
                <option value="squash">squash</option>
                <option value="rebase">rebase</option>
              </Select>
            </label>
            {(pull.head_full_name ?? pull.full_name).toLowerCase() !== pull.full_name.toLowerCase() || pull.head_branch !== pull.base_branch ? (
              <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                <input type="checkbox" checked={deleteHead} onChange={(e) => setDeleteHead(e.target.checked)} />
                {t('pulls.deleteHeadAfterMerge', 'Delete Head Branch After Merge')}
              </label>
            ) : null}
            <Button type="button" variant="primary" size="sm" loading={merging} disabled={blockedByReview} onClick={() => void doMerge()}>
              {t('pulls.mergePull', 'Merge Pull Request')}
            </Button>
          </div>
        )}
      </Card>

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
        <PullThreads owner={owner} repo={repo} number={number} canWrite={canWrite} showNotice={showNotice} authorized={authorized} />
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
