import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import type { TokenMetadata, TokenScope } from '../../types';
import { createToken, listTokens, revokeToken } from '../../services/tokenService';
import { formatExpiryTimestamp } from '../../lib/format';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input, Label } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { ReadOnlyField } from '../shared/ReadOnlyField';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

const ALL_SCOPES: TokenScope[] = ['repo:read', 'repo:write', 'admin'];

export function TokensTab({ showNotice }: { showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const [tokens, setTokens] = useState<TokenMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<TokenScope[]>([...ALL_SCOPES]);
  const [expiresInDays, setExpiresInDays] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastCreated, setLastCreated] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<TokenMetadata | null>(null);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const run = async () => {
      try {
        setTokens(await listTokens());
      } catch (error) {
        showNotice('error', error instanceof Error ? error.message : 'Failed To Load Tokens.');
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [showNotice, reloadKey]);

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const toggleScope = (scope: TokenScope) => {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (scopes.length === 0) {
      showNotice('error', t('tokens.selectAtLeastOneScope', 'Select At Least One Scope.'));
      return;
    }
    const expiry = expiresInDays.trim() === '' ? undefined : Number(expiresInDays);
    if (expiry !== undefined && (!Number.isSafeInteger(expiry) || expiry <= 0)) {
      showNotice('error', t('tokens.invalidExpiry', 'Expiry Must Be A Positive Number Of Days.'));
      return;
    }
    setSaving(true);
    try {
      const created = await createToken(name.trim(), [...scopes], expiry);
      setLastCreated(created.token);
      setName('');
      showNotice('success', t('tokens.tokenCreated', 'Token Created. Copy It Now — It Will Not Be Shown Again.'));
      setLoading(true);
      setReloadKey((k) => k + 1);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Failed To Create Token.');
    } finally {
      setSaving(false);
    }
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    try {
      await revokeToken(revoking.tokenId);
      showNotice('success', t('tokens.tokenRevoked', 'Token Revoked.'));
      setLoading(true);
      setReloadKey((k) => k + 1);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Failed To Revoke Token.');
    } finally {
      setRevoking(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('tokens.personalAccessTokens', 'Personal Access Tokens')}</CardTitle>
          <RefreshButton onRefresh={refresh} loading={loading} />
        </CardHeader>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex gap-3 flex-wrap">
            <div className="flex-1 min-w-48">
              <Input placeholder={t('tokens.tokenNamePlaceholder', 'Token Name (e.g. laptop)')} value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="w-32">
              <Input
                placeholder={t('tokens.expiryPlaceholder', 'Expiry (days)')}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                inputMode="numeric"
              />
            </div>
            <Button type="submit" variant="primary" size="sm" loading={saving}>
              <KeyRound className="h-3.5 w-3.5" />
              {t('tokens.mintToken', 'Mint Token')}
            </Button>
          </div>
          <fieldset>
            <Label>{t('tokens.scopes', 'Scopes (Git Only)')}</Label>
            <div className="mt-1.5 flex gap-4 flex-wrap">
              {ALL_SCOPES.map((scope) => (
                <label key={scope} className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  <span className="font-mono">{scope}</span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">{t('tokens.scopesHint', 'Fetch Needs repo:read. Push Needs repo:write. Admin Covers Both.')}</p>
          </fieldset>
        </form>
        {lastCreated && (
          <div className="mt-4">
            <ReadOnlyField label={t('tokens.newToken', 'New Token (Copy Once)')} value={lastCreated} showCopy />
          </div>
        )}
        <ul className="mt-4 divide-y divide-[var(--color-border)]">
          {tokens.map((token) => (
            <li key={token.tokenId} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="font-medium text-[var(--color-text-primary)] truncate">{token.name}</p>
                <p className="text-xs text-[var(--color-text-muted)]">{formatExpiryTimestamp(token.expiresAt)}</p>
                <p className="mt-1 flex gap-1.5 flex-wrap">
                  {(token.scopes ?? []).map((scope) => (
                    <span key={scope} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-[var(--color-surface)] text-[var(--color-text-secondary)]">
                      {scope}
                    </span>
                  ))}
                </p>
              </div>
              <Button variant="danger" size="sm" onClick={() => setRevoking(token)}>
                {t('tokens.revoke', 'Revoke')}
              </Button>
            </li>
          ))}
        </ul>
        {tokens.length === 0 && !loading && <p className="text-sm text-[var(--color-text-muted)] mt-4">{t('tokens.noTokens', 'No Tokens Yet.')}</p>}
      </Card>

      {revoking && (
        <ConfirmDeleteModal
          title={t('tokens.revokeToken', 'Revoke Token')}
          displayName={revoking.name}
          onConfirm={() => void confirmRevoke()}
          onCancel={() => setRevoking(null)}
        />
      )}
    </div>
  );
}
