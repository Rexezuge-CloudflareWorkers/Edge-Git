import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { deleteFile, saveFile } from '../../services/repoService';
import { Button } from '../ui/Button';
import { Input, Label, Textarea } from '../ui/Input';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

interface EditorBase {
  owner: string;
  repo: string;
  branch: string;
  expectedOid?: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onSaved: () => void;
}

function CommitMessageInput({ value, onChange, path }: { value: string; onChange: (v: string) => void; path: string }) {
  const { t } = useTranslation();
  return (
    <div>
      <Label>{t('files.commitMessage', 'Commit Message')}</Label>
      <Input
        className="mt-1"
        value={value}
        maxLength={1000}
        placeholder={t('files.commitMessagePlaceholder', 'Update {{path}}', { path })}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function FileEditor({
  owner,
  repo,
  branch,
  path,
  initialText,
  expectedOid,
  showNotice,
  onSaved,
  onCancel,
}: EditorBase & { path: string; initialText: string; onCancel: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(initialText);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = text !== initialText;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirty) {
      onCancel();
      return;
    }
    setSaving(true);
    try {
      await saveFile(owner, repo, { branch, path, content: text, message: message.trim() || undefined, expectedOid });
      showNotice('success', t('files.saved', 'File Saved.'));
      onSaved();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToSaveFile', 'Failed To Save File.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <Textarea
        aria-label={path}
        className="min-h-64 font-mono text-xs leading-relaxed"
        rows={20}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <CommitMessageInput value={message} onChange={setMessage} path={path} />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={saving} disabled={!dirty}>
          {t('files.save', 'Commit')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          {t('common.cancel', 'Cancel')}
        </Button>
        {dirty && <span className="text-xs text-[var(--color-text-muted)]">{t('files.unsavedChanges', 'You Have Unsaved Changes.')}</span>}
      </div>
    </form>
  );
}

export function NewFileForm({ owner, repo, branch, directory, expectedOid, showNotice, onSaved }: EditorBase & { directory: string }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const fullPath = directory ? `${directory}/${trimmed}` : trimmed;
    setSaving(true);
    try {
      await saveFile(owner, repo, { branch, path: fullPath, content: text, message: message.trim() || undefined, expectedOid });
      showNotice('success', t('files.saved', 'File Saved.'));
      onSaved();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToSaveFile', 'Failed To Save File.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <Label>{t('files.fileName', 'File Name')}</Label>
        <Input
          className="mt-1 font-mono"
          value={name}
          maxLength={1024}
          placeholder={t('files.fileNamePlaceholder', 'notes/todo.txt')}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <Textarea
        aria-label={t('files.fileName', 'File Name')}
        className="min-h-48 font-mono text-xs leading-relaxed"
        rows={14}
        value={text}
        placeholder={t('files.contentPlaceholder', 'File Contents…')}
        onChange={(e) => setText(e.target.value)}
      />
      <CommitMessageInput value={message} onChange={setMessage} path={name.trim() || 'new file'} />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" variant="primary" loading={saving} disabled={name.trim() === ''}>
          {t('files.save', 'Commit')}
        </Button>
      </div>
    </form>
  );
}

export function DeleteFileButton({ owner, repo, branch, path, expectedOid, showNotice, onSaved }: EditorBase & { path: string }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const confirm = async () => {
    setDeleting(true);
    try {
      await deleteFile(owner, repo, { branch, path, expectedOid });
      setConfirming(false);
      showNotice('success', t('files.deleted', 'File Deleted.'));
      onSaved();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToDeleteFile', 'Failed To Delete File.'));
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
        {t('files.deleteFile', 'Delete File')}
      </Button>
      {confirming && (
        <ConfirmDeleteModal
          title={t('files.deleteFile', 'Delete File')}
          displayName={path}
          onConfirm={() => void confirm()}
          onCancel={() => {
            if (!deleting) setConfirming(false);
          }}
        />
      )}
    </>
  );
}
