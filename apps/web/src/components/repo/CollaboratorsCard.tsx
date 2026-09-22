import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Collaborator } from '../../types';
import { listCollaborators, removeCollaborator, upsertCollaborator } from '../../services/collaboratorService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Input, Select } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

type CollaboratorRole = 'admin' | 'write' | 'read';

export function CollaboratorsCard({
  owner,
  repo,
  showNotice,
}: {
  owner: string;
  repo: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [target, setTarget] = useState('');
  const [role, setRole] = useState<CollaboratorRole>('read');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const list = await listCollaborators(owner, repo);
        if (!cancelled) setRows(list);
      } catch (error) {
        if (!cancelled)
          showNotice('error', toLocalizedErrorMessage(t, error, 'collaborators.failedToLoad', 'Failed To Load Collaborators.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, reloadKey, showNotice, t]);

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target.trim()) return;
    setSaving(true);
    try {
      await upsertCollaborator(owner, repo, target.trim(), role);
      setTarget('');
      showNotice('success', t('collaborators.updated', 'Collaborator Saved.'));
      refresh();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'collaborators.failedToSave', 'Failed To Save Collaborator.'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (member: string) => {
    try {
      await removeCollaborator(owner, repo, member);
      showNotice('success', t('collaborators.removed', 'Collaborator Removed.'));
      refresh();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'collaborators.failedToRemove', 'Failed To Remove Collaborator.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('collaborators.title', 'Collaborators')}</CardTitle>
        <RefreshButton onRefresh={refresh} loading={loading} />
      </CardHeader>
      <p className="text-sm text-[var(--color-text-secondary)] mb-4">
        {t('collaborators.hint', 'Admins Can Grant Read, Write, Or Admin Access. Organization Owners Already Have Admin Access.')}
      </p>
      <form onSubmit={submit} className="flex gap-3 flex-wrap mb-4">
        <div className="flex-1 min-w-48">
          <Input
            placeholder={t('collaborators.invitePlaceholder', 'Username Or Email')}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            required
          />
        </div>
        <Select value={role} onChange={(e) => setRole(e.target.value as CollaboratorRole)} aria-label={t('collaborators.role', 'Role')}>
          <option value="read">{t('collaborators.read', 'Read')}</option>
          <option value="write">{t('collaborators.write', 'Write')}</option>
          <option value="admin">{t('collaborators.admin', 'Admin')}</option>
        </Select>
        <Button type="submit" variant="primary" size="sm" loading={saving}>
          {t('collaborators.save', 'Save')}
        </Button>
      </form>
      <ul className="divide-y divide-[var(--color-border)]">
        {rows.map((row) => (
          <li key={row.email} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <p className="font-medium text-[var(--color-text-primary)] truncate">{row.email}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge variant={row.role === 'admin' ? 'info' : row.role === 'write' ? 'success' : 'neutral'}>{row.role}</Badge>
              <Select
                value={row.role}
                onChange={(e) => {
                  void (async () => {
                    try {
                      await upsertCollaborator(owner, repo, row.email, e.target.value as CollaboratorRole);
                      showNotice('success', t('collaborators.updated', 'Collaborator Saved.'));
                      refresh();
                    } catch (error) {
                      showNotice(
                        'error',
                        toLocalizedErrorMessage(t, error, 'collaborators.failedToSave', 'Failed To Save Collaborator.'),
                      );
                    }
                  })();
                }}
                aria-label={`Role for ${row.email}`}
              >
                <option value="read">{t('collaborators.read', 'Read')}</option>
                <option value="write">{t('collaborators.write', 'Write')}</option>
                <option value="admin">{t('collaborators.admin', 'Admin')}</option>
              </Select>
              <Button variant="danger" size="sm" onClick={() => void remove(row.email)}>
                {t('common.delete', 'Delete')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {rows.length === 0 && !loading && (
        <p className="text-sm text-[var(--color-text-muted)] mt-4">{t('collaborators.empty', 'No Collaborators Yet.')}</p>
      )}
    </Card>
  );
}
