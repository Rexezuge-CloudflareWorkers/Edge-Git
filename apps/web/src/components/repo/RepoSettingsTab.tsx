import { useState } from 'react';
import type { Repo } from '../../types';
import { deleteRepo, updateRepo } from '../../services/repoService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Label, Textarea } from '../ui/Input';
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
      showNotice('success', 'Repository Settings Updated.');
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Failed To Update Repository.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    try {
      await deleteRepo(owner, repo);
      showNotice('success', 'Repository Deleted.');
      onDeleted();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Failed To Delete Repository.');
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <RefreshButton onRefresh={reset} loading={saving} />
        </CardHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="repo-settings-description">Description</Label>
            <Textarea
              id="repo-settings-description"
              placeholder="A short description of this repository"
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
            Private repository
          </label>
          <div>
            <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!dirty}>
              Save Changes
            </Button>
          </div>
        </form>
      </Card>

      <Card className="border-[var(--color-error-text)]/40">
        <CardHeader>
          <CardTitle>Danger Zone</CardTitle>
        </CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-medium text-[var(--color-text-primary)]">Delete this repository</p>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Permanently deletes the repository, its git data, issues, and comments. This cannot be undone.
            </p>
          </div>
          <Button variant="danger" size="sm" loading={deleting} onClick={() => setConfirmingDelete(true)}>
            Delete Repository
          </Button>
        </div>
      </Card>

      {confirmingDelete && (
        <ConfirmDeleteModal
          title="Delete Repository"
          displayName={`${owner}/${repo}`}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}
