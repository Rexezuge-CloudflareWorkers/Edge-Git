import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SecretScanMode } from '../../types';
import { getSecuritySettings, setSecretScanMode } from '../../services/securityService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Label, Select } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

const MODES: SecretScanMode[] = ['off', 'warn', 'block'];

export function SecretScanCard({
  owner,
  repo,
  showNotice,
}: {
  owner: string;
  repo: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<SecretScanMode>('warn');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const settings = await getSecuritySettings(owner, repo);
      setMode(settings.secretScanMode);
    } catch {
      setMode('warn');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const settings = await getSecuritySettings(owner, repo);
        if (cancelled) return;
        setMode(settings.secretScanMode);
      } catch {
        if (!cancelled) setMode('warn');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  const save = async () => {
    setSaving(true);
    try {
      const settings = await setSecretScanMode(owner, repo, mode);
      setMode(settings.secretScanMode);
      showNotice('success', t('security.scanUpdated', 'Secret Scanning Updated.'));
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'security.updateFailed', 'Failed To Update Secret Scanning.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('security.title', 'Secret Scanning')}</CardTitle>
        <RefreshButton onRefresh={() => void refresh()} loading={loading} />
      </CardHeader>
      <div className="flex items-center gap-2 flex-wrap">
        <Label htmlFor="secret-scan-mode">{t('security.mode', 'Mode')}</Label>
        <Select id="secret-scan-mode" value={mode} onChange={(e) => setMode(e.target.value as SecretScanMode)}>
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
        <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>
          {t('common.saveChanges', 'Save Changes')}
        </Button>
      </div>
      <p className="mt-2 text-xs text-[var(--color-text-muted)]">
        {t(
          'security.hint',
          'Warn Flags Pushes And Saves Without Blocking. Block Rejects The Whole Push. Applies To Everyone Including Admins.',
        )}
      </p>
    </Card>
  );
}
