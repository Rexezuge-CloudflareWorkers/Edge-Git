import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { disbandOrg, updateOrg } from '../../services/profileService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input, Label } from '../ui/Input';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

export function OrgSettingsCard({
  org,
  showNotice,
}: {
  org: { username: string; displayName: string | null };
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(org.displayName ?? '');
  const [newUsername, setNewUsername] = useState(org.username);
  const [saving, setSaving] = useState(false);
  const [confirmingDisband, setConfirmingDisband] = useState(false);

  const dirtyDisplay = displayName.trim() !== (org.displayName ?? '');
  const dirtyUsername = newUsername.trim() !== org.username && newUsername.trim() !== '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const patch: { displayName?: string | null; username?: string } = {};
      if (dirtyDisplay) patch.displayName = displayName.trim() === '' ? null : displayName.trim();
      if (dirtyUsername) patch.username = newUsername.trim();
      const updated = await updateOrg(org.username, patch);
      showNotice('success', t('orgs.settingsUpdated', 'Organization Settings Updated.'));
      if (updated.username === org.username) {
        void navigate(0);
      } else {
        void navigate(`/${updated.username}`, { replace: true });
      }
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('orgs.failedToUpdate', 'Failed To Update Organization.'));
    } finally {
      setSaving(false);
    }
  };

  const confirmDisband = async () => {
    try {
      await disbandOrg(org.username);
      showNotice('success', t('orgs.disbanded', 'Organization Deleted.'));
      void navigate('/');
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('orgs.failedToDisband', 'Failed To Delete Organization.'));
    } finally {
      setConfirmingDisband(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('orgs.general', 'General')}</CardTitle>
        </CardHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="org-display-name">{t('orgs.displayName', 'Display Name')}</Label>
            <Input
              id="org-display-name"
              placeholder={t('orgs.displayNamePlaceholder', 'Organization Display Name')}
              value={displayName}
              maxLength={100}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="org-username">{t('orgs.username', 'Username')}</Label>
            <Input id="org-username" value={newUsername} maxLength={39} onChange={(e) => setNewUsername(e.target.value)} />
            <p className="text-xs text-[var(--color-text-muted)]">{t('orgs.renameHint', 'Renaming Changes All Repository URLs Under This Organization.')}</p>
          </div>
          <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!dirtyDisplay && !dirtyUsername}>
            {t('common.saveChanges', 'Save Changes')}
          </Button>
        </form>
      </Card>

      <Card className="border-[var(--color-error-text)]/40">
        <CardHeader>
          <CardTitle>{t('orgs.dangerZone', 'Danger Zone')}</CardTitle>
        </CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-medium text-[var(--color-text-primary)]">{t('orgs.deleteThisOrg', 'Delete This Organization')}</p>
            <p className="text-sm text-[var(--color-text-secondary)]">
              {t('orgs.deleteOrgDescription', 'Delete The Organization Once All Repositories Are Removed. This Cannot Be Undone.')}
            </p>
          </div>
          <Button variant="danger" size="sm" onClick={() => setConfirmingDisband(true)}>
            {t('orgs.deleteOrg', 'Delete Organization')}
          </Button>
        </div>
      </Card>

      {confirmingDisband && (
        <ConfirmDeleteModal
          title={t('orgs.deleteOrg', 'Delete Organization')}
          displayName={org.username}
          onConfirm={() => void confirmDisband()}
          onCancel={() => setConfirmingDisband(false)}
        />
      )}
    </div>
  );
}
