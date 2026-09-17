import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createOrg } from '../../services/profileService';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Input';
import { ModalShell } from '../modals/ModalShell';

export function OrgCreateModal({
  showNotice,
  onCreated,
  onClose,
}: {
  showNotice: (type: 'success' | 'error', text: string) => void;
  onCreated: (username: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) return;
    setSaving(true);
    try {
      const org = await createOrg({ username: username.trim() });
      showNotice('success', t('orgs.created', 'Organization {{username}} Created.', { username: org.username }));
      onCreated(org.username);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('orgs.failedToCreate', 'Failed To Create Organization.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} widthClass="w-full max-w-md mx-4" ariaLabel={t('orgs.newOrg', 'New Organization')}>
      <form onSubmit={submit} className="p-6 space-y-4">
        <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('orgs.newOrg', 'New Organization')}</h2>
        <div className="space-y-1.5">
          <Label htmlFor="org-create-username">{t('orgs.username', 'Username')}</Label>
          <Input
            id="org-create-username"
            placeholder={t('orgs.usernamePlaceholder', 'my-org')}
            value={username}
            maxLength={39}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div className="flex gap-3 justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={saving}>
            {t('common.create', 'Create')}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}
