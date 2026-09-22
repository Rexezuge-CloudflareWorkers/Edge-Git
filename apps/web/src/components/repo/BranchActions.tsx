import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createBranch, deleteBranch } from '../../services/repoService';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

export function BranchActions({
  owner,
  repo,
  branches,
  defaultBranch,
  selectedRef,
  showNotice,
  onChanged,
}: {
  owner: string;
  repo: string;
  branches: string[];
  defaultBranch: string | null;
  selectedRef: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onChanged: (ref: string) => void;
}) {
  const { t } = useTranslation();
  const [forming, setForming] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const isTagRef = selectedRef.startsWith('refs/tags/');
  const isDefault = !isTagRef && selectedRef !== '' && selectedRef === defaultBranch;
  const canDelete = !isTagRef && selectedRef !== '' && !isDefault && branches.includes(selectedRef);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      const created = await createBranch(owner, repo, trimmed, isTagRef || selectedRef === '' ? undefined : selectedRef);
      const ref = created.ref ?? created.branch ?? trimmed;
      setName('');
      setForming(false);
      showNotice('success', t('branches.created', 'Branch Created.'));
      onChanged(ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref);
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToCreateBranch', 'Failed To Create Branch.'));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await deleteBranch(owner, repo, selectedRef);
      setConfirmingDelete(false);
      showNotice('success', t('branches.deleted', 'Branch Deleted.'));
      onChanged('');
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToDeleteBranch', 'Failed To Delete Branch.'));
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setName('');
          setForming((f) => !f);
        }}
      >
        {t('branches.newBranch', 'New Branch')}
      </Button>
      {canDelete && (
        <Button size="sm" variant="danger" onClick={() => setConfirmingDelete(true)}>
          {t('branches.deleteBranch', 'Delete Branch')}
        </Button>
      )}
      {forming && (
        <form onSubmit={submit} className="flex items-center gap-2">
          <Input
            aria-label={t('branches.branchName', 'Branch Name')}
            placeholder={t('branches.branchNamePlaceholder', 'feature-name')}
            value={name}
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" size="sm" variant="primary" loading={saving} disabled={name.trim() === ''}>
            {t('common.create', 'Create')}
          </Button>
        </form>
      )}
      {confirmingDelete && (
        <ConfirmDeleteModal
          title={t('branches.deleteBranch', 'Delete Branch')}
          displayName={selectedRef}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            if (!deleting) setConfirmingDelete(false);
          }}
        />
      )}
    </>
  );
}
