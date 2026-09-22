import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../../types';
import { createProject, listProjects } from '../../services/projectService';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

export interface UseProjectsOptions {
  owner: string;
  repo: string;
  authorized?: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
}

/**
 * Project list slice: loading, first-item auto-select, refresh, and the
 * create-project mutation. Board-level state lives in `useProjectBoard`;
 * the parent coordinates both (`selectProject` also clears the board).
 */
export function useProjects({ owner, repo, authorized, showNotice }: UseProjectsOptions) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    const run = async () => {
      try {
        const list = await listProjects(owner, repo, authOpt);
        setProjects(list);
        setSelected((prev) => prev ?? list[0]?.number ?? null);
      } catch (error) {
        showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadProjects', 'Failed To Load Projects.'));
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [owner, repo, showNotice, t, authorized, reloadKey]);

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const create = async (title: string): Promise<number | null> => {
    setSaving(true);
    try {
      const { project } = await createProject(owner, repo, { title: title.trim() });
      showNotice('success', t('projects.projectCreated', 'Project Created.'));
      setSelected(project.number);
      refresh();
      return project.number;
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToCreateProject', 'Failed To Create Project.'));
      return null;
    } finally {
      setSaving(false);
    }
  };

  return { projects, selected, setSelected, loading, saving, refresh, create };
}
