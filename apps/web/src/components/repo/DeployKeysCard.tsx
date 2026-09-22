import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import type { CreatedDeployKey, DeployKey, DeployKeyPermission } from '../../types';
import { createDeployKey, listDeployKeys, revokeDeployKey } from '../../services/deployKeyService';
import { formatExpiryTimestamp } from '../../lib/format';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input, Select } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { ReadOnlyField } from '../shared/ReadOnlyField';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

export function DeployKeysCard({
  owner,
  repo,
  showNotice,
}: {
  owner: string;
  repo: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<DeployKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [permission, setPermission] = useState<DeployKeyPermission>('read');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastCreated, setLastCreated] = useState<CreatedDeployKey | null>(null);
  const [revoking, setRevoking] = useState<DeployKey | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const run = async () => {
      try {
        setKeys(await listDeployKeys(owner, repo));
      } catch {
        // Deploy keys table may be missing on legacy DBs — degrade silently.
        setKeys([]);
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [owner, repo, reloadKey]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const expiry = expiresInDays.trim() === '' ? undefined : Number(expiresInDays);
    if (expiry !== undefined && (!Number.isSafeInteger(expiry) || expiry <= 0)) {
      showNotice('error', t('deployKeys.invalidExpiry', 'Expiry Must Be A Positive Number Of Days.'));
      return;
    }
    setSaving(true);
    try {
      const created = await createDeployKey(owner, repo, name.trim(), permission, expiry);
      setLastCreated(created);
      setName('');
      showNotice('success', t('deployKeys.keyCreated', 'Deploy Key Created. Copy It Now — It Will Not Be Shown Again.'));
      setLoading(true);
      setReloadKey((k) => k + 1);
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'deployKeys.createFailed', 'Failed To Create Deploy Key.'));
    } finally {
      setSaving(false);
    }
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    try {
      await revokeDeployKey(owner, repo, revoking.id);
      showNotice('success', t('deployKeys.keyRevoked', 'Deploy Key Revoked.'));
      setLoading(true);
      setReloadKey((k) => k + 1);
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'deployKeys.revokeFailed', 'Failed To Revoke Deploy Key.'));
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div>
      <Card>
        <CardHeader>
          <CardTitle>{t('deployKeys.title', 'Deploy Keys')}</CardTitle>
          <RefreshButton
            onRefresh={() => {
              setLoading(true);
              setReloadKey((k) => k + 1);
            }}
            loading={loading}
          />
        </CardHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex gap-2 flex-wrap">
            <div className="flex-1 min-w-40">
              <Input
                placeholder={t('deployKeys.namePlaceholder', 'Key Name (e.g. ci-runner)')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <Select
              aria-label={t('deployKeys.permission', 'Permission')}
              value={permission}
              onChange={(e) => setPermission(e.target.value as DeployKeyPermission)}
            >
              <option value="read">read</option>
              <option value="write">write</option>
            </Select>
            <div className="w-32">
              <Input
                placeholder={t('deployKeys.expiryPlaceholder', 'Expiry (days)')}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                inputMode="numeric"
              />
            </div>
            <Button type="submit" variant="primary" size="sm" loading={saving}>
              <KeyRound className="h-3.5 w-3.5" />
              {t('deployKeys.addKey', 'Add Key')}
            </Button>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            {t('deployKeys.hint', 'Git Only. Scoped To This Repository. Use As The HTTPS Password.')}
          </p>
        </form>
        {lastCreated && (
          <div className="mt-4">
            <ReadOnlyField label={t('deployKeys.newKey', 'New Deploy Key (Copy Once)')} value={lastCreated.key} showCopy />
          </div>
        )}
        <ul className="mt-4 divide-y divide-[var(--color-border)]">
          {keys.map((key) => (
            <li key={key.id} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="font-medium text-[var(--color-text-primary)] truncate">
                  {key.name}
                  {key.tokenPrefix && <span className="ml-2 font-mono text-xs text-[var(--color-text-muted)]">{key.tokenPrefix}…</span>}
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">{formatExpiryTimestamp(key.expiresAt)}</p>
                <p className="mt-1">
                  <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-[var(--color-surface)] text-[var(--color-text-secondary)]">
                    {key.permission}
                  </span>
                </p>
              </div>
              <Button variant="danger" size="sm" onClick={() => setRevoking(key)}>
                {t('deployKeys.revoke', 'Revoke')}
              </Button>
            </li>
          ))}
        </ul>
        {keys.length === 0 && !loading && (
          <p className="text-sm text-[var(--color-text-muted)] mt-4">{t('deployKeys.noKeys', 'No Deploy Keys Yet.')}</p>
        )}
      </Card>

      {revoking && (
        <ConfirmDeleteModal
          title={t('deployKeys.revokeKey', 'Revoke Deploy Key')}
          displayName={revoking.name}
          onConfirm={() => void confirmRevoke()}
          onCancel={() => setRevoking(null)}
        />
      )}
    </div>
  );
}
