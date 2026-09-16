import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CurrentUser } from '../../types';
import { renameCurrentUsername, loadCurrentUser, updateCurrentUser } from '../../services/userService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input, Label } from '../ui/Input';

export function ProfileSettingsCard({
  user,
  setUser,
  showNotice,
}: {
  user: CurrentUser;
  setUser: (user: CurrentUser) => void;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [newUsername, setNewUsername] = useState(user.username ?? '');
  const [saving, setSaving] = useState(false);

  const dirtyDisplay = displayName.trim() !== (user.displayName ?? '');
  const trimmedUsername = newUsername.trim();
  const dirtyUsername = trimmedUsername !== '' && trimmedUsername !== (user.username ?? '');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      let updated: CurrentUser | null = dirtyDisplay
        ? await updateCurrentUser({
            displayName: displayName.trim() === '' ? null : displayName.trim(),
          })
        : null;
      if (dirtyUsername) {
        updated = await renameCurrentUsername(trimmedUsername);
      }
      if (updated) {
        setUser(updated);
        setDisplayName(updated.displayName ?? '');
        setNewUsername(updated.username ?? '');
        showNotice('success', t('settings.settingsUpdated', 'Profile Settings Updated.'));
      }
    } catch (error) {
      // Partial success: a display-name update may have succeeded before a
      // failed rename. Refresh local state from the server when possible so
      // the form does not show stale values.
      try {
        const current = await loadCurrentUser();
        setUser(current);
        setDisplayName(current.displayName ?? '');
        setNewUsername(current.username ?? '');
      } catch {
        // Ignore refresh failures — the error notice below is authoritative.
      }
      showNotice('error', error instanceof Error ? error.message : t('settings.failedToUpdate', 'Failed To Update Profile.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('settings.profile', 'Profile')}</CardTitle>
      </CardHeader>
      <dl className="space-y-2 text-sm mb-4">
        <div className="flex gap-2">
          <dt className="text-[var(--color-text-muted)] w-20 shrink-0">{t('settings.email', 'Email')}</dt>
          <dd className="text-[var(--color-text-primary)] truncate">{user.email}</dd>
        </div>
      </dl>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="user-display-name">{t('settings.displayName', 'Display Name')}</Label>
          <Input
            id="user-display-name"
            placeholder={t('settings.displayNamePlaceholder', 'Your Display Name')}
            value={displayName}
            maxLength={100}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="user-username">{t('settings.username', 'Username')}</Label>
          <Input
            id="user-username"
            placeholder={t('settings.usernamePlaceholder', 'your-username')}
            value={newUsername}
            maxLength={39}
            onChange={(e) => setNewUsername(e.target.value)}
          />
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('settings.renameHint', 'Renaming Changes All Repository URLs Under Your Account.')}
          </p>
        </div>
        <Button type="submit" variant="primary" size="sm" loading={saving} disabled={!dirtyDisplay && !dirtyUsername}>
          {t('common.saveChanges', 'Save Changes')}
        </Button>
      </form>
    </Card>
  );
}
