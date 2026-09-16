import { useTranslation } from 'react-i18next';
import { UserRound } from 'lucide-react';
import type { CurrentUser } from '../types';
import { ProfileSettingsCard } from '../components/settings/ProfileSettingsCard';
import { TokensTab } from '../components/settings/TokensTab';
import { Card } from '../components/ui/Card';

export function SettingsView({
  user,
  setUser,
  showNotice,
}: {
  user: CurrentUser;
  setUser: (user: CurrentUser) => void;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-4">
      <Card className="flex items-center gap-3 py-4">
        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-[var(--color-surface-3)]">
          <UserRound className="h-5 w-5 text-[var(--color-text-secondary)]" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">{t('settings.userSettings', 'User Settings')}</h1>
          <p className="text-sm text-[var(--color-text-muted)] truncate">{user.email}</p>
        </div>
      </Card>

      <ProfileSettingsCard user={user} setUser={setUser} showNotice={showNotice} />

      <TokensTab showNotice={showNotice} />
    </div>
  );
}
