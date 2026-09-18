import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { DeleteFileButton, FileEditor } from './FileEditor';
import { getBlame } from '../../services/collabService';

export function BlobView({
  owner,
  repo,
  branch,
  blobPath,
  blobText,
  blobBinary,
  branchTip,
  editing,
  editableFile,
  showNotice,
  onSaved,
  onEdit,
  onCancelEdit,
  onBack,
}: {
  owner: string;
  repo: string;
  branch: string;
  blobPath: string;
  blobText: string | null;
  blobBinary: boolean;
  branchTip?: string;
  editing: boolean;
  editableFile: boolean;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onSaved: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const [blame, setBlame] = useState<Array<{ line: number; commitOid: string; author: string; content: string }> | null>(null);
  const [blameLoading, setBlameLoading] = useState(false);
  const toggleBlame = async () => {
    if (blame) {
      setBlame(null);
      return;
    }
    setBlameLoading(true);
    try {
      const res = await getBlame(owner, repo, blobPath, branch, true).catch(() => null);
      setBlame(res?.lines ?? []);
    } finally {
      setBlameLoading(false);
    }
  };
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm text-[var(--color-text-primary)]">{blobPath}</span>
        <div className="flex items-center gap-2">
          {!editing && !blobBinary && blobText && (
            <Button size="sm" variant="secondary" onClick={() => void toggleBlame()} disabled={blameLoading}>
              {blame ? t('files.hideBlame', 'Hide Blame') : t('files.blame', 'Blame')}
            </Button>
          )}
          {!editing && editableFile && (
            <>
              <Button size="sm" onClick={onEdit}>
                {t('files.edit', 'Edit')}
              </Button>
              <DeleteFileButton
                owner={owner}
                repo={repo}
                branch={branch}
                path={blobPath}
                expectedOid={branchTip}
                showNotice={showNotice}
                onSaved={onSaved}
              />
            </>
          )}
          <button type="button" className="text-sm text-[var(--color-accent)] hover:underline" onClick={onBack}>
            {t('repos.backToFiles', 'Back To Files')}
          </button>
        </div>
      </div>
      {editing ? (
        <FileEditor
          key={blobPath}
          owner={owner}
          repo={repo}
          branch={branch}
          path={blobPath}
          initialText={blobText ?? ''}
          expectedOid={branchTip}
          showNotice={showNotice}
          onSaved={onSaved}
          onCancel={onCancelEdit}
        />
      ) : blobBinary ? (
        <p className="text-sm text-[var(--color-text-muted)]">{t('repos.binaryFile', 'Binary File — Not Previewed.')}</p>
      ) : blame ? (
        <ul className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-base)] p-4 font-mono text-xs leading-relaxed">
          {blame.map((l) => (
            <li key={l.line} className="flex gap-3 whitespace-pre-wrap break-words">
              <span className="w-8 shrink-0 text-[var(--color-text-muted)]">{l.line}</span>
              <span className="w-24 shrink-0 truncate text-[var(--color-accent)]" title={l.commitOid}>
                {l.commitOid.slice(0, 7)} {l.author}
              </span>
              <span className="flex-1 text-[var(--color-text-primary)]">{l.content}</span>
            </li>
          ))}
        </ul>
      ) : (
        <pre className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-base)] p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
          {blobText ?? t('repos.emptyFile', 'Empty File.')}
        </pre>
      )}
    </Card>
  );
}
