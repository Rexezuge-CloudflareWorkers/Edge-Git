import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import type { TokenMetadata } from '../../types';
import { createToken, listTokens, revokeToken } from '../../services/tokenService';
import { formatExpiryTimestamp } from '../../lib/format';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { ReadOnlyField } from '../shared/ReadOnlyField';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';

export function TokensTab({ showNotice }: { showNotice: (type: 'success' | 'error', text: string) => void }) {
  const [tokens, setTokens] = useState<TokenMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const created = await createToken(name.trim());
      setLastCreated(created.token);
      setName('');
      showNotice('success', 'Token Created. Copy It Now — It Will Not Be Shown Again.');
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
      showNotice('success', 'Token Revoked.');
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
          <CardTitle>Personal Access Tokens</CardTitle>
          <RefreshButton onRefresh={refresh} loading={loading} />
        </CardHeader>
        <form onSubmit={submit} className="flex gap-3 flex-wrap">
          <div className="flex-1 min-w-48">
            <Input placeholder="Token name (e.g. laptop)" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <Button type="submit" variant="primary" size="sm" loading={saving}>
            <KeyRound className="h-3.5 w-3.5" />
            Mint Token
          </Button>
        </form>
        {lastCreated && (
          <div className="mt-4">
            <ReadOnlyField label="New Token (Copy Once)" value={lastCreated} showCopy />
          </div>
        )}
        <ul className="mt-4 divide-y divide-[var(--color-border)]">
          {tokens.map((t) => (
            <li key={t.tokenId} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="font-medium text-[var(--color-text-primary)] truncate">{t.name}</p>
                <p className="text-xs text-[var(--color-text-muted)]">{formatExpiryTimestamp(t.expiresAt)}</p>
              </div>
              <Button variant="danger" size="sm" onClick={() => setRevoking(t)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
        {tokens.length === 0 && !loading && <p className="text-sm text-[var(--color-text-muted)] mt-4">No tokens yet.</p>}
      </Card>

      {revoking && (
        <ConfirmDeleteModal
          title="Revoke Token"
          displayName={revoking.name}
          onConfirm={() => void confirmRevoke()}
          onCancel={() => setRevoking(null)}
        />
      )}
    </div>
  );
}
