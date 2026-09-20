import { useTranslation } from 'react-i18next';
import type { MergePreview, PullRequest } from '../../types';
import { PullChecks } from './PullChecks';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Select, Textarea } from '../ui/Input';

type MergeStrategy = 'merge' | 'squash' | 'rebase';

interface PullMergePanelProps {
  owner: string;
  repo: string;
  pull: PullRequest;
  preview: MergePreview | null;
  blockedByReview: boolean;
  conflicts: string[];
  conflictReason: string | null;
  mergeMessage: string;
  setMergeMessage: (v: string) => void;
  strategy: MergeStrategy;
  setStrategy: (v: MergeStrategy) => void;
  deleteHead: boolean;
  setDeleteHead: (v: boolean) => void;
  merging: boolean;
  canManage: boolean;
  authorized?: boolean | null;
  onMerge: () => void;
}

// Merge-status facade: preview + review gate + checks + conflict list +
// merge form. Extracted from PullDetail so the detail view stays under the
// god-file guard.
export function PullMergePanel(props: PullMergePanelProps) {
  const { t } = useTranslation();
  const {
    owner,
    repo,
    pull,
    preview,
    blockedByReview,
    conflicts,
    conflictReason,
    mergeMessage,
    setMergeMessage,
    strategy,
    setStrategy,
    deleteHead,
    setDeleteHead,
    merging,
    canManage,
    authorized,
    onMerge,
  } = props;
  return (
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
        <p className="mt-2 text-sm text-[var(--color-error-text)]">
          {t('pulls.blockedByReview', 'Blocked: Unresolved Change Requests.')}
        </p>
      )}
      <PullChecks owner={owner} repo={repo} headOid={pull.head_oid} authorized={authorized} />
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
          {(pull.head_full_name ?? pull.full_name).toLowerCase() !== pull.full_name.toLowerCase() ||
          pull.head_branch !== pull.base_branch ? (
            <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
              <input type="checkbox" checked={deleteHead} onChange={(e) => setDeleteHead(e.target.checked)} />
              {t('pulls.deleteHeadAfterMerge', 'Delete Head Branch After Merge')}
            </label>
          ) : null}
          <Button type="button" variant="primary" size="sm" loading={merging} disabled={blockedByReview} onClick={onMerge}>
            {t('pulls.mergePull', 'Merge Pull Request')}
          </Button>
        </div>
      )}
    </Card>
  );
}
