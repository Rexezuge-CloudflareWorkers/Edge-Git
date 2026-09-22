import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Discussion, DiscussionComment } from '../../types';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import {
  addDiscussionComment,
  deleteDiscussion,
  deleteDiscussionComment,
  loadDiscussion,
  updateDiscussion,
} from '../../services/discussionService';

export interface UseDiscussionDetailOptions {
  owner: string;
  repo: string;
  selected: number | null;
  authorized?: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
}

export interface DiscussionDetail {
  discussion: Discussion;
  comments: DiscussionComment[];
}

/**
 * Open-discussion slice: detail loading plus comment/status mutations.
 * The parent owns URL selection and list refresh; deletion reports back
 * so the parent can clear the selection (`onDeleted`).
 */
export function useDiscussionDetail({ owner, repo, selected, authorized, showNotice }: UseDiscussionDetailOptions) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<DiscussionDetail | null>(null);
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (selected === null) return;
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    const run = async () => {
      try {
        setDetail(await loadDiscussion(owner, repo, selected, authOpt));
      } catch (error) {
        showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadDiscussions', 'Failed To Load Discussions.'));
      }
    };
    void run();
  }, [owner, repo, selected, showNotice, t, authorized]);

  const reloadDetail = async (number: number) => {
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    try {
      setDetail(await loadDiscussion(owner, repo, number, authOpt));
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadDiscussions', 'Failed To Load Discussions.'));
    }
  };

  const clearDetail = () => setDetail(null);

  const submitComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selected === null || !comment.trim()) return;
    try {
      await addDiscussionComment(owner, repo, selected, comment.trim());
      setComment('');
      await reloadDetail(selected);
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToAddComment', 'Failed To Add Comment.'));
    }
  };

  const removeComment = (number: number, commentId: string) => {
    void deleteDiscussionComment(owner, repo, number, commentId).then(() => reloadDetail(number));
  };

  const setStatus = (number: number, status: 'open' | 'answered' | 'locked') => {
    void updateDiscussion(owner, repo, number, { status }).then(() => reloadDetail(number).then(() => undefined));
  };

  const removeDiscussion = async (number: number): Promise<void> => {
    await deleteDiscussion(owner, repo, number);
  };

  return { detail, clearDetail, reloadDetail, comment, setComment, submitComment, removeComment, setStatus, removeDiscussion };
}
