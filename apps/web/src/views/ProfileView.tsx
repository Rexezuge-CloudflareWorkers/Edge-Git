import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2, UserRound } from 'lucide-react';
import type { OrgMember, OrgSummary, Repo, UserOrOrgProfile } from '../types';
import { listOrgMembers, listProfileOrgs, listProfileRepos, loadProfile } from '../services/profileService';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { VisibilityBadge } from '../components/ui/Badge';
import { OrgSettingsCard } from '../components/org/OrgSettingsCard';
import { OrgMembersManager } from '../components/org/OrgMembersManager';
import { cn } from '../lib/utils';

type ProfileTab = 'repositories' | 'organizations' | 'people' | 'manage';

export function ProfileView({
  showNotice,
}: {
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { username = '' } = useParams<{ username: string }>();
  const { t } = useTranslation();
  const [profile, setProfile] = useState<UserOrOrgProfile | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [tab, setTab] = useState<ProfileTab>('repositories');

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!cancelled) setStatus('loading');
      try {
        const data = await loadProfile(username);
        if (cancelled) return;
        setProfile(data);
        const [repoRows, orgRows] = await Promise.all([
          listProfileRepos(username).catch(() => [] as Repo[]),
          data.type === 'user' ? listProfileOrgs(username).catch(() => [] as OrgSummary[]) : Promise.resolve([] as OrgSummary[]),
        ]);
        if (cancelled) return;
        setRepos(repoRows);
        setOrgs(orgRows);
        setMembers(null);
        setTab('repositories');
        if (data.type === 'org' && data.viewerIsMember) {
          const memberRows = await listOrgMembers(username).catch(() => null);
          if (!cancelled) setMembers(memberRows);
        }
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('missing');
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [username]);

  if (status === 'loading') {
    return (
      <div className="min-h-64 flex items-center justify-center">
        <div className="h-10 w-10 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin" />
      </div>
    );
  }

  if (status === 'missing' || !profile) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <Card>
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">{t('profile.notFound', 'Profile Not Found')}</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {t('profile.notFoundDescription', 'This User Or Organization Does Not Exist.')}
          </p>
        </Card>
      </div>
    );
  }

  const isOrg = profile.type === 'org';
  const canManageOrg = isOrg && profile.viewerIsOwner === true;
  const tabs: ProfileTab[] = isOrg
    ? canManageOrg
      ? ['repositories', 'people', 'manage']
      : ['repositories', 'people']
    : ['repositories', 'organizations'];

  const visibleTab: ProfileTab = tabs.includes(tab) ? tab : 'repositories';

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-4">
      <Card className="flex items-center gap-4">
        <div className="flex items-center justify-center w-12 h-12 rounded-full bg-[var(--color-surface-3)] shrink-0">
          {isOrg ? (
            <Building2 className="h-6 w-6 text-[var(--color-text-secondary)]" />
          ) : (
            <UserRound className="h-6 w-6 text-[var(--color-text-secondary)]" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-semibold text-[var(--color-text-primary)] truncate">{profile.username}</h1>
            <Badge variant={isOrg ? 'info' : 'neutral'}>
              {isOrg ? t('profile.organization', 'Organization') : t('profile.user', 'User')}
            </Badge>
          </div>
          {profile.displayName && <p className="text-sm text-[var(--color-text-secondary)] truncate">{profile.displayName}</p>}
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            {t('profile.repoCount', '{{count}} Repositories', { count: profile.repoCount ?? repos.length })}
            {!isOrg && profile.orgCount != null ? ` · ${t('profile.orgCount', '{{count}} Organizations', { count: profile.orgCount })}` : ''}
            {isOrg && profile.memberCount != null ? ` · ${t('profile.memberCount', '{{count}} Members', { count: profile.memberCount })}` : ''}
          </p>
        </div>
      </Card>

      <div className="flex items-center gap-1 rounded-lg bg-[var(--color-surface-2)] p-1 w-fit">
        {tabs.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'px-3.5 py-1.5 rounded-md text-sm transition-colors duration-150',
              visibleTab === key
                ? 'bg-[var(--color-surface-1)] text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]',
            )}
          >
            {key === 'repositories'
              ? t('profile.repositories', 'Repositories')
              : key === 'organizations'
                ? t('profile.organizations', 'Organizations')
                : key === 'people'
                  ? t('profile.people', 'People')
                  : t('profile.manage', 'Manage')}
          </button>
        ))}
      </div>

      {visibleTab === 'repositories' && (
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.repositories', 'Repositories')}</CardTitle>
            <span className="text-sm text-[var(--color-text-muted)]">{repos.length}</span>
          </CardHeader>
          {repos.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)] py-6 text-center">{t('profile.noRepos', 'No Visible Repositories.')}</p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {repos.map((r) => (
                <li key={r.fullName} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <Link to={`/${r.owner}/${r.name}`} className="font-medium text-[var(--color-accent)] hover:underline truncate">
                      {r.fullName}
                    </Link>
                    {r.description && <p className="text-sm text-[var(--color-text-secondary)] truncate">{r.description}</p>}
                  </div>
                  <VisibilityBadge isPrivate={r.isPrivate} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {visibleTab === 'organizations' && !isOrg && (
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.organizations', 'Organizations')}</CardTitle>
            <span className="text-sm text-[var(--color-text-muted)]">{orgs.length}</span>
          </CardHeader>
          {orgs.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)] py-6 text-center">{t('profile.noOrgs', 'No Visible Organizations.')}</p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {orgs.map((o) => (
                <li key={o.username} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <Link to={`/${o.username}`} className="font-medium text-[var(--color-accent)] hover:underline truncate">
                      {o.username}
                    </Link>
                    {o.displayName && <p className="text-sm text-[var(--color-text-secondary)] truncate">{o.displayName}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {visibleTab === 'people' && isOrg && (
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.people', 'People')}</CardTitle>
            {profile.memberCount != null && <span className="text-sm text-[var(--color-text-muted)]">{profile.memberCount}</span>}
          </CardHeader>
          {members === null ? (
            <p className="text-sm text-[var(--color-text-muted)] py-6 text-center">
              {t('profile.membersRestricted', 'Member List Is Visible To Organization Members Only.')}
            </p>
          ) : members.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)] py-6 text-center">{t('profile.noMembers', 'No Members Found.')}</p>
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {members.map((m) => (
                <li key={m.email} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="font-medium text-[var(--color-text-primary)] truncate">{m.username ?? m.email}</p>
                    <p className="text-xs text-[var(--color-text-muted)] truncate">{m.email}</p>
                  </div>
                  <Badge variant={m.role === 'owner' ? 'info' : 'neutral'}>{m.role}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {visibleTab === 'manage' && isOrg && canManageOrg && (
        <div className="space-y-4">
          <OrgMembersManager org={profile.username} showNotice={showNotice} />
          <OrgSettingsCard org={{ username: profile.username, displayName: profile.displayName }} showNotice={showNotice} />
        </div>
      )}
    </div>
  );
}
