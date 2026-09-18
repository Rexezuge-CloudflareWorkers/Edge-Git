import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PullReview } from '../../types';
import { addPullReview, dismissPullReview, listPullReviews } from '../../services/pullService';
import { getCodeowners, requestReviewers } from '../../services/collabService';
import { formatTimestamp } from '../../lib/format';
import { Markdown } from '../shared/Markdown';
import { Button } from '../ui/Button';
import { CardHeader, CardTitle } from '../ui/Card';
import { Select, Textarea } from '../ui/Input';
import { Badge } from '../ui/Badge';

export function PullReviews({
  owner,
  repo,
  number,
  reviews,
  onReviewsChange,
  canWrite,
  canManage,
  isOpen,
  showNotice,
  authorized,
}: {
  owner: string;
  repo: string;
  number: number;
  reviews: PullReview[];
  onReviewsChange: (reviews: PullReview[]) => void;
  canWrite: boolean;
  canManage: boolean;
  isOpen: boolean;
  showNotice: (type: 'success' | 'error', text: string) => void;
  authorized?: boolean | null;
}) {
  const { t } = useTranslation();
  const [codeowners, setCodeowners] = useState<string[]>([]);
  const [reviewerInput, setReviewerInput] = useState('');
  const [reviewState, setReviewState] = useState('approved');
  const [reviewBody, setReviewBody] = useState('');
  const [reviewing, setReviewing] = useState(false);

  const useAuthed = authorized === true;

  useEffect(() => {
    if (!useAuthed) return;
    let cancelled = false;
    void getCodeowners(owner, repo, number)
      .then((res) => {
        if (!cancelled) setCodeowners(res.owners ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [owner, repo, number, useAuthed]);

  const refresh = async () => {
    try {
      onReviewsChange(await listPullReviews(owner, repo, number));
    } catch {
      // Best-effort refresh after mutations.
    }
  };

  const submitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    setReviewing(true);
    try {
      await addPullReview(owner, repo, number, { state: reviewState, body: reviewBody.trim() || undefined });
      setReviewBody('');
      await refresh();
      showNotice('success', t('pulls.reviewSubmitted', 'Review Submitted.'));
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToAddReview', 'Failed To Submit Review.'));
    } finally {
      setReviewing(false);
    }
  };

  return (
    <div>
      <CardHeader>
        <CardTitle>{t('pulls.reviews', 'Reviews')}</CardTitle>
      </CardHeader>
      {codeowners.length > 0 && (
        <div className="mb-2 flex items-center gap-2 flex-wrap">
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('pulls.suggestedReviewers', 'Suggested Reviewers: {{owners}}', { owners: codeowners.join(', ') })}
          </p>
          {canWrite && isOpen && (
            <button
              type="button"
              onClick={() => {
                void requestReviewers(owner, repo, number, codeowners)
                  .then(() => showNotice('success', t('pulls.reviewRequested', 'Review Requested.')))
                  .catch((error) =>
                    showNotice(
                      'error',
                      error instanceof Error ? error.message : t('errors.failedToRequestReview', 'Failed To Request Review.'),
                    ),
                  );
              }}
              className="text-xs text-[var(--color-accent)] hover:underline"
            >
              {t('pulls.requestAll', 'Request All')}
            </button>
          )}
        </div>
      )}
      {canWrite && isOpen && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!reviewerInput.trim()) return;
            void requestReviewers(owner, repo, number, [reviewerInput.trim()])
              .then(() => {
                setReviewerInput('');
                showNotice('success', t('pulls.reviewRequested', 'Review Requested.'));
              })
              .catch((error) =>
                showNotice(
                  'error',
                  error instanceof Error ? error.message : t('errors.failedToRequestReview', 'Failed To Request Review.'),
                ),
              );
          }}
          className="mb-3 flex gap-2"
        >
          <input
            className="flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-base)] px-3 py-2 text-sm"
            placeholder={t('pulls.requestReviewerPlaceholder', 'Request Reviewer (Email Or Username)…')}
            value={reviewerInput}
            onChange={(e) => setReviewerInput(e.target.value)}
          />
          <Button type="submit" variant="secondary" size="sm">
            {t('pulls.requestReview', 'Request')}
          </Button>
        </form>
      )}
      {reviews.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">{t('pulls.noReviews', 'No Reviews Yet.')}</p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {reviews.map((r) => (
            <li key={r.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={r.state === 'approved' ? 'success' : r.state === 'changes_requested' ? 'error' : 'neutral'}>
                  {r.state}
                </Badge>
                {r.dismissed === 1 && <Badge variant="neutral">{t('pulls.dismissed', 'Dismissed')}</Badge>}
                <span className="text-xs text-[var(--color-text-muted)]">
                  {r.author_email} · {formatTimestamp(r.created_at)}
                </span>
                {canManage && isOpen && r.dismissed !== 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      void dismissPullReview(owner, repo, number, r.id)
                        .then(() => void refresh())
                        .catch((error) =>
                          showNotice(
                            'error',
                            error instanceof Error ? error.message : t('errors.failedToDismissReview', 'Failed To Dismiss Review.'),
                          ),
                        );
                    }}
                    className="ml-auto text-xs text-[var(--color-accent)] hover:underline"
                  >
                    {t('pulls.dismissReview', 'Dismiss')}
                  </button>
                )}
              </div>
              {r.body && (
                <div className="mt-1 text-sm text-[var(--color-text-primary)]">
                  <Markdown content={r.body} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && isOpen && (
        <form onSubmit={submitReview} className="mt-4 space-y-2">
          <Select value={reviewState} onChange={(e) => setReviewState(e.target.value)} aria-label="Review state">
            <option value="approved">approved</option>
            <option value="changes_requested">changes_requested</option>
            <option value="commented">commented</option>
          </Select>
          <Textarea
            placeholder={t('pulls.reviewPlaceholder', 'Review Notes (Optional)')}
            value={reviewBody}
            onChange={(e) => setReviewBody(e.target.value)}
            rows={2}
          />
          <Button type="submit" variant="secondary" size="sm" loading={reviewing}>
            {t('pulls.submitReview', 'Submit Review')}
          </Button>
        </form>
      )}
    </div>
  );
}
