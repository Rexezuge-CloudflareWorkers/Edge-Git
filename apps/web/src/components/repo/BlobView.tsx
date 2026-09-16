import { useTranslation } from 'react-i18next';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { DeleteFileButton, FileEditor } from './FileEditor';

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
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="font-mono text-sm text-[var(--color-text-primary)]">{blobPath}</span>
        <div className="flex items-center gap-2">
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
      ) : (
        <pre className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-base)] p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
          {blobText ?? t('repos.emptyFile', 'Empty File.')}
        </pre>
      )}
    </Card>
  );
}
