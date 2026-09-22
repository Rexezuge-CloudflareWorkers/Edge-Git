import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Input, Select } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { useTeams } from './useTeams';
import { useTeamDetail } from './useTeamDetail';

export function OrgTeamsManager({ org, showNotice }: { org: string; showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const teamsHook = useTeams({ org, showNotice });
  const { selected } = teamsHook;
  const detailHook = useTeamDetail({ org, selected, showNotice });
  const { members, grants, detailLoading } = detailHook;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('teams.title', 'Teams')}</CardTitle>
        <RefreshButton onRefresh={teamsHook.refresh} loading={teamsHook.loading} />
      </CardHeader>
      <form onSubmit={teamsHook.create} className="flex gap-3 flex-wrap mb-4">
        <div className="flex-1 min-w-48">
          <Input
            placeholder={t('teams.slugPlaceholder', 'team-slug')}
            value={teamsHook.slug}
            onChange={(e) => teamsHook.setSlug(e.target.value)}
            required
            maxLength={39}
          />
        </div>
        <Button type="submit" variant="primary" size="sm" loading={teamsHook.creating}>
          {t('teams.create', 'Create Team')}
        </Button>
      </form>
      {teamsHook.teams.length > 0 && (
        <div className="flex gap-2 flex-wrap mb-4">
          {teamsHook.teams.map((tm) => (
            <Button
              key={tm.id}
              variant={selected === tm.slug ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => {
                if (tm.slug === selected) {
                  return;
                }
                teamsHook.setSelected(tm.slug);
              }}
            >
              {tm.slug}
            </Button>
          ))}
        </div>
      )}
      {selected && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h4 className="font-medium text-[var(--color-text-primary)]">{selected}</h4>
            <Button variant="danger" size="sm" onClick={() => void teamsHook.removeTeam(selected)}>
              {t('common.delete', 'Delete')}
            </Button>
          </div>
          <form onSubmit={detailHook.invite} className="flex gap-3 flex-wrap">
            <div className="flex-1 min-w-48">
              <Input
                placeholder={t('orgs.invitePlaceholder', 'Username Or Email')}
                value={detailHook.target}
                onChange={(e) => detailHook.setTarget(e.target.value)}
                required
              />
            </div>
            <Select
              value={detailHook.memberRole}
              onChange={(e) => detailHook.setMemberRole(e.target.value as 'admin' | 'member')}
              aria-label={t('orgs.role', 'Role')}
            >
              <option value="member">{t('teams.member', 'Member')}</option>
              <option value="admin">{t('teams.admin', 'Admin')}</option>
            </Select>
            <Button type="submit" variant="primary" size="sm">
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
                  <Badge variant={m.role === 'admin' ? 'info' : 'neutral'}>
                    {m.role === 'admin' ? t('teams.admin', 'Admin') : t('teams.member', 'Member')}
                  </Badge>
                  <Select
                    value={m.role}
                    onChange={(e) => void detailHook.changeRole(m.username ?? m.email, e.target.value as 'admin' | 'member')}
                    aria-label={`Role for ${m.email}`}
                  >
                    <option value="member">{t('teams.member', 'Member')}</option>
                    <option value="admin">{t('teams.admin', 'Admin')}</option>
                  </Select>
                  <Button variant="danger" size="sm" onClick={() => void detailHook.removeMember(m.username ?? m.email)}>
                    {t('common.delete', 'Delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <form onSubmit={detailHook.grant} className="flex gap-3 flex-wrap">
            <div className="flex-1 min-w-48">
              <Input
                placeholder={t('teams.repoPlaceholder', 'owner/name')}
                value={detailHook.repoInput}
                onChange={(e) => detailHook.setRepoInput(e.target.value)}
                required
              />
            </div>
            <Select
              value={detailHook.grantRole}
              onChange={(e) => detailHook.setGrantRole(e.target.value as 'admin' | 'write' | 'read')}
              aria-label={t('orgs.grantRole', 'Grant Role')}
            >
              <option value="read">{t('collaborators.read', 'Read')}</option>
              <option value="write">{t('collaborators.write', 'Write')}</option>
              <option value="admin">{t('collaborators.admin', 'Admin')}</option>
            </Select>
            <Button type="submit" variant="primary" size="sm">
              {t('teams.grant', 'Grant Access')}
            </Button>
          </form>
          <ul className="divide-y divide-[var(--color-border)]">
            {grants.map((g) => (
              <li key={g.repoId} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="font-medium text-[var(--color-text-primary)] truncate">{g.fullName ?? g.repoId}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant="neutral">{g.role}</Badge>
                  <Button variant="danger" size="sm" onClick={() => void detailHook.revoke(g.fullName)}>
                    {t('common.delete', 'Delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {members.length === 0 && grants.length === 0 && !detailLoading && (
            <p className="text-sm text-[var(--color-text-muted)]">{t('teams.empty', 'No Members Or Repository Grants Yet.')}</p>
          )}
        </div>
      )}
      {teamsHook.teams.length === 0 && !teamsHook.loading && (
        <p className="text-sm text-[var(--color-text-muted)] mt-4">{t('teams.noTeams', 'No Teams Yet.')}</p>
      )}
    </Card>
  );
}
