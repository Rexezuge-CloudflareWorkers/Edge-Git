import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Discussion, DiscussionCategory } from '../../types';
import { listDiscussionCategories, listDiscussions } from '../../services/discussionService';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

export interface UseDiscussionsOptions {
  owner: string;
  repo: string;
  category: string;
  authorized?: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
}

/**
 * Discussion list slice: categories + filtered discussions with a `reload`
 * refresh. Detail-level state (open discussion, comments) lives in
 * `useDiscussionDetail`; the create form stays in `DiscussionsTab`.
 */
export function useDiscussions({ owner, repo, category, authorized, showNotice }: UseDiscussionsOptions) {
  const { t } = useTranslation();
  const [categories, setCategories] = useState<DiscussionCategory[]>([]);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    const run = async () => {
      try {
        const [cats, list] = await Promise.all([
          listDiscussionCategories(owner, repo, authOpt),
          listDiscussions(owner, repo, category || undefined, authOpt),
        ]);
        setCategories(cats);
        setDiscussions(list);
      } catch (error) {
        showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadDiscussions', 'Failed To Load Discussions.'));
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [owner, repo, showNotice, t, authorized, category, reloadKey]);

  const reload = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  return { categories, discussions, loading, reload };
}
