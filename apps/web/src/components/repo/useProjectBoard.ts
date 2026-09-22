import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectBoard } from '../../types';
import {
  createCard,
  createColumn,
  deleteCard,
  deleteColumn,
  loadProjectBoard,
  moveCard,
  renameColumn,
  setCardArchived,
  updateProject,
} from '../../services/projectService';
import { nextPosition } from '../../lib/projectOrder';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

export interface UseProjectBoardOptions {
  owner: string;
  repo: string;
  selected: number | null;
  authorized?: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
  onProjectStatusChanged: () => void;
}

/**
 * Project board slice: board loading plus every column/card mutation.
 * Owns the column/card draft fields so `ProjectsTab` keeps only the
 * project-create form and the JSX layout.
 */
export function useProjectBoard({ owner, repo, selected, authorized, showNotice, onProjectStatusChanged }: UseProjectBoardOptions) {
  const { t } = useTranslation();
  const [board, setBoard] = useState<ProjectBoard | null>(null);
  const [columnTitle, setColumnTitle] = useState('');
  const [noteTitle, setNoteTitle] = useState('');
  const [activeColumn, setActiveColumn] = useState<string | null>(null);

  useEffect(() => {
    if (selected === null) return;
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    const run = async () => {
      try {
        setBoard(await loadProjectBoard(owner, repo, selected, authOpt));
      } catch (error) {
        showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadProjects', 'Failed To Load Projects.'));
      }
    };
    void run();
  }, [owner, repo, selected, showNotice, t, authorized]);

  const refreshBoard = async () => {
    if (selected === null) return;
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    try {
      setBoard(await loadProjectBoard(owner, repo, selected, authOpt));
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadProjects', 'Failed To Load Projects.'));
    }
  };

  const clearBoard = () => setBoard(null);

  const submitColumn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selected === null || !columnTitle.trim()) return;
    try {
      await createColumn(owner, repo, selected, columnTitle.trim());
      setColumnTitle('');
      showNotice('success', t('projects.columnCreated', 'Column Created.'));
      await refreshBoard();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToCreateColumn', 'Failed To Create Column.'));
    }
  };

  const submitCard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selected === null || !activeColumn || !noteTitle.trim()) return;
    try {
      await createCard(owner, repo, selected, { columnId: activeColumn, kind: 'note', noteTitle: noteTitle.trim() });
      setNoteTitle('');
      showNotice('success', t('projects.cardCreated', 'Card Created.'));
      await refreshBoard();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToCreateCard', 'Failed To Create Card.'));
    }
  };

  const moveCardTo = async (cardId: string, toColumnId: string) => {
    if (selected === null || !board) return;
    const siblings = board.cards.filter((c) => c.columnId === toColumnId && c.id !== cardId && !c.archived);
    try {
      await moveCard(owner, repo, selected, cardId, { toColumnId, position: nextPosition(siblings.map((c) => c.position)) });
      await refreshBoard();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToMoveCard', 'Failed To Move Card.'));
    }
  };

  const renameColumnPrompt = (columnId: string, current: string) => {
    const next = globalThis.prompt(t('projects.renameColumn', 'Rename Column'), current);
    if (selected !== null && next?.trim()) void renameColumn(owner, repo, selected, columnId, next.trim()).then(() => refreshBoard());
  };

  const toggleStatus = async () => {
    if (!board) return;
    await updateProject(owner, repo, board.project.number, { status: board.project.status === 'open' ? 'closed' : 'open' });
    await refreshBoard();
    onProjectStatusChanged();
  };

  const removeColumn = (columnId: string) => {
    if (selected === null) return;
    void deleteColumn(owner, repo, selected, columnId).then(() => refreshBoard());
  };

  const archiveCard = (cardId: string) => {
    if (selected === null) return;
    void setCardArchived(owner, repo, selected, cardId, true).then(() => refreshBoard());
  };

  const removeCard = (cardId: string) => {
    if (selected === null) return;
    void deleteCard(owner, repo, selected, cardId).then(() => refreshBoard());
  };

  return {
    board,
    clearBoard,
    refreshBoard,
    columnTitle,
    setColumnTitle,
    noteTitle,
    setNoteTitle,
    activeColumn,
    setActiveColumn,
    submitColumn,
    submitCard,
    moveCardTo,
    renameColumnPrompt,
    toggleStatus,
    removeColumn,
    archiveCard,
    removeCard,
  };
}
