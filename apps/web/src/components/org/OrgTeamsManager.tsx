import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Team, TeamMember, TeamRepoGrant } from '../../types';
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  grantTeamRepo,
  listTeamMembers,
  listTeamRepos,
  listTeams,
  removeTeamMember,
  revokeTeamRepo,
  setTeamMemberRole,
} from '../../services/teamService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Input, Select } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';

function splitRepo(value: string): { owner: string; repo: string } | null {
  const trimmed = value.trim().replace(/\.git$/, '');
  const parts = trimmed.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

export function OrgTeamsManager({ org, showNotice }: { org: string; showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [slug, setSlug] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [grants, setGrants] = useState<TeamRepoGrant[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [target, setTarget] = useState('');
  const [memberRole, setMemberRole] = useState<'admin' | 'member'>('member');
  const [repoInput, setRepoInput] = useState('');
  const [grantRole, setGrantRole] = useState<'admin' | 'write' | 'read'>('read');
  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selected;
  });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const rows = await listTeams(org);
        if (cancelled) return;
        setTeams(rows);
        if (rows.length === 0) {
          setSelected(null);
          setMembers([]);
          setGrants([]);
        } else if (rows.every((r) => r.slug !== selectedRef.current)) {
          setDetailLoading(true);
          setSelected(rows[0]?.slug ?? null);
        }
      } catch (error) {
        if (!cancelled) showNotice('error', error instanceof Error ? error.message : t('teams.failedToLoad', 'Failed To Load Teams.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [org, reloadKey, showNotice, t]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const run = async () => {
      try {
        const [m, g] = await Promise.all([listTeamMembers(org, selected), listTeamRepos(org, selected)]);
        if (!cancelled) {
          setMembers(m);
          setGrants(g);
        }
      } catch (error) {
        if (!cancelled)
          showNotice('error', error instanceof Error ? error.message : t('teams.failedToLoadDetail', 'Failed To Load Team Details.'));
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [org, selected, reloadKey, showNotice, t]);

  const refreshDetail = async (teamSlug: string) => {
    try {
      const [m, g] = await Promise.all([listTeamMembers(org, teamSlug), listTeamRepos(org, teamSlug)]);
      setMembers(m);
      setGrants(g);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('teams.failedToLoadDetail', 'Failed To Load Team Details.'));
    }
  };

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!slug.trim()) return;
    setCreating(true);
    try {
      const team = await createTeam(org, { slug: slug.trim() });
      setSlug('');
      setSelected(team.slug);
      showNotice('success', t('teams.created', 'Team Created.'));
      refresh();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('teams.failedToCreate', 'Failed To Create Team.'));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (teamSlug: string) => {
    try {
      await deleteTeam(org, teamSlug);
      if (selected === teamSlug) {
        setSelected(null);
        setMembers([]);
        setGrants([]);
      }
      showNotice('success', t('teams.deleted', 'Team Deleted.'));
      refresh();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('teams.failedToDelete', 'Failed To Delete Team.'));
    }
  };

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !target.trim()) return;
    try {
      const value = target.trim();
      await addTeamMember(org, selected, value.includes('@') ? { email: value, role: memberRole } : { username: value, role: memberRole });
      setTarget('');
      showNotice('success', t('teams.memberAdded', 'Team Member Added.'));
      void refreshDetail(selected);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('teams.failedToAddMember', 'Failed To Add Team Member.'));
    }
  };

  const changeRole = async (member: string, next: 'admin' | 'member') => {
    if (!selected) return;
    try {
      await setTeamMemberRole(org, selected, member, next);
      showNotice('success', t('teams.roleUpdated', 'Team Member Role Updated.'));
      void refreshDetail(selected);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('teams.failedToUpdateRole', 'Failed To Update Team Member Role.'));
    }
  };

  const removeMember = async (member: string) => {
    if (!selected) return;
    try {
      await removeTeamMember(org, selected, member);
      showNotice('success', t('teams.memberRemoved', 'Team Member Removed.'));
      void refreshDetail(selected);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('teams.failedToRemoveMember', 'Failed To Remove Team Member.'));
    }
  };

  const grant = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    const parsed = splitRepo(repoInput);
    if (!parsed) {
      showNotice('error', t('teams.invalidRepo', 'Enter A Repository As owner/name.'));
      return;
    }
    try {
      await grantTeamRepo(org, selected, parsed.owner, parsed.repo, grantRole);
      setRepoInput('');
      showNotice('success', t('teams.grantSaved', 'Repository Grant Saved.'));
      void refreshDetail(selected);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('teams.failedToSaveGrant', 'Failed To Save Repository Grant.'));
    }
  };

  const revoke = async (fullName: string | null) => {
    if (!selected || !fullName) return;
    const parsed = splitRepo(fullName);
    if (!parsed) return;
    try {
      await revokeTeamRepo(org, selected, parsed.owner, parsed.repo);
      showNotice('success', t('teams.grantRevoked', 'Repository Grant Revoked.'));
      void refreshDetail(selected);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('teams.failedToRevokeGrant', 'Failed To Revoke Repository Grant.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('teams.title', 'Teams')}</CardTitle>
        <RefreshButton onRefresh={refresh} loading={loading} />
      </CardHeader>
      <form onSubmit={create} className="flex gap-3 flex-wrap mb-4">
        <div className="flex-1 min-w-48">
          <Input
            placeholder={t('teams.slugPlaceholder', 'team-slug')}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
            maxLength={39}
          />
        </div>
        <Button type="submit" variant="primary" size="sm" loading={creating}>
          {t('teams.create', 'Create Team')}
        </Button>
      </form>
      {teams.length > 0 && (
        <div className="flex gap-2 flex-wrap mb-4">
          {teams.map((tm) => (
            <Button
              key={tm.id}
              variant={selected === tm.slug ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => {
                if (tm.slug === selected) {
                  return;
                }

                setDetailLoading(true);
                setSelected(tm.slug);
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
            <Button variant="danger" size="sm" onClick={() => void remove(selected)}>
              {t('common.delete', 'Delete')}
            </Button>
          </div>
          <form onSubmit={invite} className="flex gap-3 flex-wrap">
            <div className="flex-1 min-w-48">
              <Input
                placeholder={t('orgs.invitePlaceholder', 'Username Or Email')}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                required
              />
            </div>
            <Select value={memberRole} onChange={(e) => setMemberRole(e.target.value as 'admin' | 'member')} aria-label="Role">
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
                    onChange={(e) => void changeRole(m.username ?? m.email, e.target.value as 'admin' | 'member')}
                    aria-label={`Role for ${m.email}`}
                  >
                    <option value="member">{t('teams.member', 'Member')}</option>
                    <option value="admin">{t('teams.admin', 'Admin')}</option>
                  </Select>
                  <Button variant="danger" size="sm" onClick={() => void removeMember(m.username ?? m.email)}>
                    {t('common.delete', 'Delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <form onSubmit={grant} className="flex gap-3 flex-wrap">
            <div className="flex-1 min-w-48">
              <Input
                placeholder={t('teams.repoPlaceholder', 'owner/name')}
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                required
              />
            </div>
            <Select value={grantRole} onChange={(e) => setGrantRole(e.target.value as 'admin' | 'write' | 'read')} aria-label="Grant role">
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
                  <Button variant="danger" size="sm" onClick={() => void revoke(g.fullName)}>
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
      {teams.length === 0 && !loading && (
        <p className="text-sm text-[var(--color-text-muted)] mt-4">{t('teams.noTeams', 'No Teams Yet.')}</p>
      )}
    </Card>
  );
}
