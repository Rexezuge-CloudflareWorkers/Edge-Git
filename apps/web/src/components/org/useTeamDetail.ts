import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamMember, TeamRepoGrant } from '../../types';
import {
  addTeamMember,
  grantTeamRepo,
  listTeamMembers,
  listTeamRepos,
  removeTeamMember,
  revokeTeamRepo,
  setTeamMemberRole,
} from '../../services/teamService';
import { splitRepo } from './teamRepoInput';

export interface UseTeamDetailOptions {
  org: string;
  selected: string | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
}

interface LoadedDetail {
  selected: string;
  members: TeamMember[];
  grants: TeamRepoGrant[];
}

/**
 * Selected-team slice: members/grants plus every member/grant mutation.
 *
 * Derived-state design (no `setState` inside effects): the loaded detail
 * records which selection it belongs to, so a selection change
 * immediately derives empty members/grants + `detailLoading` until the
 * fetch for the new selection lands. Team deletion/empty lists clear via
 * `selected` becoming null — the list hook never reaches across the split.
 */
export function useTeamDetail({ org, selected, showNotice }: UseTeamDetailOptions) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<LoadedDetail | null>(null);
  const [target, setTarget] = useState('');
  const [memberRole, setMemberRole] = useState<'admin' | 'member'>('member');
  const [repoInput, setRepoInput] = useState('');
  const [grantRole, setGrantRole] = useState<'admin' | 'write' | 'read'>('read');

  const settled = selected !== null && detail?.selected === selected;
  const members = settled ? (detail?.members ?? []) : [];
  const grants = settled ? (detail?.grants ?? []) : [];
  const detailLoading = selected !== null && !settled;

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const run = async () => {
      try {
        const [m, g] = await Promise.all([listTeamMembers(org, selected), listTeamRepos(org, selected)]);
        if (!cancelled) setDetail({ selected, members: m, grants: g });
      } catch (error) {
        if (!cancelled)
          showNotice('error', error instanceof Error ? error.message : t('teams.failedToLoadDetail', 'Failed To Load Team Details.'));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [org, selected, showNotice, t]);

  const refreshDetail = async (teamSlug: string) => {
    if (teamSlug !== selected) return;
    try {
      const [m, g] = await Promise.all([listTeamMembers(org, teamSlug), listTeamRepos(org, teamSlug)]);
      setDetail({ selected: teamSlug, members: m, grants: g });
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('teams.failedToLoadDetail', 'Failed To Load Team Details.'));
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

  return {
    members,
    grants,
    detailLoading,
    refreshDetail,
    target,
    setTarget,
    memberRole,
    setMemberRole,
    repoInput,
    setRepoInput,
    grantRole,
    setGrantRole,
    invite,
    changeRole,
    removeMember,
    grant,
    revoke,
  };
}
