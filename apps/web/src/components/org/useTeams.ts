import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Team } from '../../types';
import { createTeam, deleteTeam, listTeams } from '../../services/teamService';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

export interface UseTeamsOptions {
  org: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
}

/**
 * Team list slice: loading, first-team auto-select, create/delete.
 * Detail state (members/grants) lives in `useTeamDetail`, which clears
 * itself whenever `selected` becomes null — so this hook never reaches
 * across the split.
 */
export function useTeams({ org, showNotice }: UseTeamsOptions) {
  const { t } = useTranslation();
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [slug, setSlug] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
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
        } else if (rows.every((r) => r.slug !== selectedRef.current)) {
          setSelected(rows[0]?.slug ?? null);
        }
      } catch (error) {
        if (!cancelled) showNotice('error', toLocalizedErrorMessage(t, error, 'teams.failedToLoad', 'Failed To Load Teams.'));
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
      showNotice('error', toLocalizedErrorMessage(t, error, 'teams.failedToCreate', 'Failed To Create Team.'));
    } finally {
      setCreating(false);
    }
  };

  const removeTeam = async (teamSlug: string) => {
    try {
      await deleteTeam(org, teamSlug);
      if (selectedRef.current === teamSlug) setSelected(null);
      showNotice('success', t('teams.deleted', 'Team Deleted.'));
      refresh();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'teams.failedToDelete', 'Failed To Delete Team.'));
    }
  };

  return { teams, loading, refresh, slug, setSlug, creating, create, selected, setSelected, removeTeam };
}
