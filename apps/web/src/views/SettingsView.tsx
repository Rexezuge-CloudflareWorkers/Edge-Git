import { UserRound } from 'lucide-react';
import type { CurrentUser } from '../types';
import { TokensTab } from '../components/settings/TokensTab';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';

export function SettingsView({
  user,
  showNotice,
}: {
  user: CurrentUser;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-4">
      <Card className="flex items-center gap-3 py-4">
        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-[var(--color-surface-3)]">
          <UserRound className="h-5 w-5 text-[var(--color-text-secondary)]" />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">User Settings</h1>
          <p className="text-sm text-[var(--color-text-muted)] truncate">{user.email}</p>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <dl className="space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="text-[var(--color-text-muted)] w-20 shrink-0">Email</dt>
            <dd className="text-[var(--color-text-primary)] truncate">{user.email}</dd>
          </div>
        </dl>
      </Card>

      <TokensTab showNotice={showNotice} />
    </div>
  );
}
