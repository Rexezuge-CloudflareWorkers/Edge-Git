import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OrgMember } from '../../types';
import { inviteOrgMember, listOrgMembers, removeOrgMember, setOrgMemberRole } from '../../services/profileService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Input, Select } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';

export function OrgMembersManager({ org, showNotice }: { org: string; showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [target, setTarget] = useState('');
  const [role, setRole] = useState<'owner' | 'member'>('member');
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const rows = await listOrgMembers(org);
        if (!cancelled) setMembers(rows);
      } catch (error) {
        if (!cancelled)
          showNotice('error', error instanceof Error ? error.message : t('orgs.failedToLoadMembers', 'Failed To Load Members.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [org, reloadKey, showNotice, t]);

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target.trim()) return;
    setInviting(true);
    try {
      const value = target.trim();
      await inviteOrgMember(org, value.includes('@') ? { email: value, role } : { username: value, role });
      setTarget('');
      showNotice('success', t('orgs.memberAdded', 'Member Added.'));
      refresh();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('orgs.failedToAddMember', 'Failed To Add Member.'));
    } finally {
      setInviting(false);
    }
  };

  const changeRole = async (member: string, next: 'owner' | 'member') => {
    try {
      await setOrgMemberRole(org, member, next);
      showNotice('success', t('orgs.roleUpdated', 'Member Role Updated.'));
      refresh();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('orgs.failedToUpdateRole', 'Failed To Update Member Role.'));
    }
  };

  const remove = async (member: string) => {
    try {
      await removeOrgMember(org, member);
      showNotice('success', t('orgs.memberRemoved', 'Member Removed.'));
      refresh();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('orgs.failedToRemoveMember', 'Failed To Remove Member.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('orgs.members', 'Members')}</CardTitle>
        <RefreshButton onRefresh={refresh} loading={loading} />
      </CardHeader>
      <form onSubmit={invite} className="flex gap-3 flex-wrap mb-4">
        <div className="flex-1 min-w-48">
          <Input
            placeholder={t('orgs.invitePlaceholder', 'Username Or Email')}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            required
          />
        </div>
        <Select value={role} onChange={(e) => setRole(e.target.value as 'owner' | 'member')} aria-label="Role">
          <option value="member">{t('orgs.member', 'Member')}</option>
          <option value="owner">{t('orgs.owner', 'Owner')}</option>
        </Select>
        <Button type="submit" variant="primary" size="sm" loading={inviting}>
          {t('orgs.invite', 'Invite')}
        </Button>
      </form>
      <ul className="divide-y divide-[var(--color-border)]">
        {members.map((m) => (
          <li key={m.email} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <p className="font-medium text-[var(--color-text-primary)] truncate">{m.username ?? m.email}</p>
              <p className="text-xs text-[var(--color-text-muted)] truncate">{m.email}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge variant={m.role === 'owner' ? 'info' : 'neutral'}>
                {m.role === 'owner' ? t('orgs.owner', 'Owner') : t('orgs.member', 'Member')}
              </Badge>
              <Select
                value={m.role}
                onChange={(e) => void changeRole(m.username ?? m.email, e.target.value as 'owner' | 'member')}
                aria-label={`Role for ${m.email}`}
              >
                <option value="member">{t('orgs.member', 'Member')}</option>
                <option value="owner">{t('orgs.owner', 'Owner')}</option>
              </Select>
              <Button variant="danger" size="sm" onClick={() => void remove(m.username ?? m.email)}>
                {t('common.delete', 'Delete')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {members.length === 0 && !loading && (
        <p className="text-sm text-[var(--color-text-muted)] mt-4">{t('orgs.noMembers', 'No Members Yet.')}</p>
      )}
    </Card>
  );
}
