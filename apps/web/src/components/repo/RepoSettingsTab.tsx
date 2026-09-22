import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Repo } from '../../types';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { deleteRepo, loadBranches, setDefaultBranch, updateRepo } from '../../services/repoService';
import { BranchProtectionCard } from './BranchProtectionCard';
import { CollaboratorsCard } from './CollaboratorsCard';
import { WebhooksCard } from './WebhooksCard';
import { TransferCard } from './TransferCard';
import { DeployKeysCard } from './DeployKeysCard';
import { SecretScanCard } from './SecretScanCard';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Label, Select, Textarea } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

export function RepoSettingsTab({
  owner,
  repo,
  repoMeta,
  showNotice,
  onUpdated,
  onDeleted,
}: {
  owner: string;
  repo: string;
  repoMeta: Repo;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onUpdated: (repo: Repo) => void;
  onDeleted: () => void;
}) {
  const [description, setDescription] = useState(repoMeta.description ?? '');
  const [isPrivate, setIsPrivate] = useState(repoMeta.isPrivate);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranchName] = useState('');
  const [savingDefault, setSavingDefault] = useState(false);
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;
    loadBranches(owner, repo)
      .then((b) => {
        if (cancelled) return;
        setBranches(b.branches);
        setDefaultBranchName(b.currentBranch ?? '');
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  const saveDefaultBranch = async () => {
    if (!defaultBranch) return;
    setSavingDefault(true);
    try {
      const updated = await setDefaultBranch(owner, repo, defaultBranch);
      setDefaultBranchName(updated.defaultBranch);
      showNotice('success', t('branches.defaultUpdated', 'Default Branch Updated.'));
    } catch (error) {
      showNotice(
        'error',
        toLocalizedErrorMessage(t, error, 'errors.failedToUpdateDefaultBranch', 'Failed To Update Default Branch.'),
      );
    } finally {
      setSavingDefault(false);
    }
  };

  const dirty = description.trim() !== (repoMeta.description ?? '') || isPrivate !== repoMeta.isPrivate;

  const reset = () => {
    setDescription(repoMeta.description ?? '');
    setIsPrivate(repoMeta.isPrivate);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await updateRepo(owner, repo, {
        description: description.trim() === '' ? null : description.trim(),
        isPrivate,
      });
      onUpdated(updated);
      showNotice('success', t('repos.repositorySettingsUpdated', 'Repository Settings Updated.'));
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToUpdateRepository', 'Failed To Update Repository.'));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await deleteRepo(owner, repo);
      showNotice('success', t('repos.repositoryDeleted', 'Repository Deleted.'));
      onDeleted();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToDeleteRepository', 'Failed To Delete Repository.'));
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('repos.general', 'General')}</CardTitle>
          <RefreshButton onRefresh={reset} loading={saving} />
        </CardHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="repo-settings-description">{t('repos.description', 'Description')}</Label>
            <Textarea
              id="repo-settings-description"
              placeholder={t('repos.descriptionPlaceholderSettings', 'A Short Description Of This Repository')}
              value={description}
              maxLength={500}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2.5 text-sm text-[var(--color-text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            {t('repos.privateRepository', 'Private Repository')}
          </label>
          <div>
            <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!dirty}>
              {t('common.saveChanges', 'Save Changes')}
            </Button>
          </div>
        </form>
      </Card>

      <CollaboratorsCard owner={owner} repo={repo} showNotice={showNotice} />

      <BranchProtectionCard owner={owner} repo={repo} showNotice={showNotice} />

      <WebhooksCard owner={owner} repo={repo} showNotice={showNotice} />

      <TransferCard owner={owner} repo={repo} showNotice={showNotice} />

      <DeployKeysCard owner={owner} repo={repo} showNotice={showNotice} />

      <SecretScanCard owner={owner} repo={repo} showNotice={showNotice} />

      <Card>
        <CardHeader>
          <CardTitle>{t('branches.defaultBranch', 'Default Branch')}</CardTitle>
        </CardHeader>
        <div className="flex items-center gap-2 flex-wrap">
          <Select
            aria-label={t('branches.defaultBranch', 'Default Branch')}
            value={defaultBranch}
            onChange={(e) => setDefaultBranchName(e.target.value)}
            disabled={branches.length === 0}
          >
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="primary" loading={savingDefault} disabled={!defaultBranch} onClick={() => void saveDefaultBranch()}>
            {t('common.saveChanges', 'Save Changes')}
          </Button>
        </div>
      </Card>

      <Card className="border-[var(--color-error-text)]/40">
        <CardHeader>
          <CardTitle>{t('repos.dangerZone', 'Danger Zone')}</CardTitle>
        </CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-medium text-[var(--color-text-primary)]">{t('repos.deleteThisRepository', 'Delete This Repository')}</p>
            <p className="text-sm text-[var(--color-text-secondary)]">
              {t(
                'repos.deleteRepositoryDescription',
                'Permanently Deletes The Repository, Its Git Data, Issues, And Comments. This Cannot Be Undone.',
              )}
            </p>
          </div>
          <Button variant="danger" size="sm" loading={deleting} onClick={() => setConfirmingDelete(true)}>
            {t('repos.deleteRepository', 'Delete Repository')}
          </Button>
        </div>
      </Card>

      {confirmingDelete && (
        <ConfirmDeleteModal
          title={t('repos.deleteRepository', 'Delete Repository')}
          displayName={`${owner}/${repo}`}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
