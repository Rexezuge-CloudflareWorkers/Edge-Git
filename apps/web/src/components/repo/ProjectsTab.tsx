import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KanbanSquare } from 'lucide-react';
import type { Project, ProjectBoard, ProjectCard } from '../../types';
import {
  createCard,
  createColumn,
  createProject,
  deleteCard,
  deleteColumn,
  listProjects,
  loadProjectBoard,
  moveCard,
  renameColumn,
  setCardArchived,
  updateProject,
} from '../../services/projectService';
import { nextPosition } from '../../lib/projectOrder';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';

function ProjectCardItem({
  card,
  columnTitles,
  onMove,
  onArchive,
  onDelete,
  moveLabel,
}: {
  card: ProjectCard;
  columnTitles: Array<{ id: string; title: string }>;
  onMove: (toColumnId: string) => void;
  onArchive: () => void;
  onDelete: () => void;
  moveLabel: (title: string) => string;
}) {
  return (
    <li className="rounded border border-[var(--color-border)] p-2 text-sm">
      <p className="font-medium">{card.kind === 'note' ? (card.noteTitle ?? 'Untitled') : `${card.kind} card`}</p>
      {card.noteBody && <p className="text-xs text-[var(--color-text-secondary)] mt-1">{card.noteBody}</p>}
      <div className="mt-2 flex gap-1 flex-wrap">
        {columnTitles.map((target) => (
          <Button key={target.id} size="sm" onClick={() => onMove(target.id)}>
            {moveLabel(target.title)}
          </Button>
        ))}
        <Button size="sm" onClick={onArchive}>
          Archive
        </Button>
        <Button size="sm" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </li>
  );
}

export function ProjectsTab({
  owner,
  repo,
  canWrite,
  showNotice,
  authorized,
}: {
  owner: string;
  repo: string;
  canWrite: boolean;
  showNotice: (type: 'success' | 'error', text: string) => void;
  authorized?: boolean | null;
}) {
  const { t } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [board, setBoard] = useState<ProjectBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [columnTitle, setColumnTitle] = useState('');
  const [noteTitle, setNoteTitle] = useState('');
  const [activeColumn, setActiveColumn] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    const run = async () => {
      try {
        const list = await listProjects(owner, repo, authOpt);
        setProjects(list);
        setSelected((prev) => prev ?? list[0]?.number ?? null);
      } catch (error) {
        showNotice('error', error instanceof Error ? error.message : t('errors.failedToLoadProjects', 'Failed To Load Projects.'));
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [owner, repo, showNotice, t, authorized, reloadKey]);

  useEffect(() => {
    if (selected === null) return;
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    const run = async () => {
      try {
        setBoard(await loadProjectBoard(owner, repo, selected, authOpt));
      } catch (error) {
        showNotice('error', error instanceof Error ? error.message : t('errors.failedToLoadProjects', 'Failed To Load Projects.'));
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
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToLoadProjects', 'Failed To Load Projects.'));
    }
  };

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const selectProject = (number: number) => {
    setBoard(null);
    setSelected(number);
  };

  const submitProject = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { project } = await createProject(owner, repo, { title: title.trim() });
      setTitle('');
      showNotice('success', t('projects.projectCreated', 'Project Created.'));
      setBoard(null);
      setSelected(project.number);
      refresh();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToCreateProject', 'Failed To Create Project.'));
    } finally {
      setSaving(false);
    }
  };

  const submitColumn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selected === null || !columnTitle.trim()) return;
    try {
      await createColumn(owner, repo, selected, columnTitle.trim());
      setColumnTitle('');
      showNotice('success', t('projects.columnCreated', 'Column Created.'));
      await refreshBoard();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToCreateColumn', 'Failed To Create Column.'));
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
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToCreateCard', 'Failed To Create Card.'));
    }
  };

  const moveCardTo = async (cardId: string, toColumnId: string) => {
    if (selected === null || !board) return;
    const siblings = board.cards.filter((c) => c.columnId === toColumnId && c.id !== cardId && !c.archived);
    try {
      await moveCard(owner, repo, selected, cardId, { toColumnId, position: nextPosition(siblings.map((c) => c.position)) });
      await refreshBoard();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToMoveCard', 'Failed To Move Card.'));
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
    refresh();
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

  return (
    <div className="space-y-4">
      {canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>{t('projects.newProject', 'New Project')}</CardTitle>
          </CardHeader>
          <form onSubmit={submitProject} className="flex gap-2">
            <Input
              placeholder={t('projects.titlePlaceholder', 'Project Title')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
            <Button type="submit" variant="primary" size="sm" loading={saving}>
              {t('common.create', 'Create')}
            </Button>
          </form>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('projects.projects', 'Projects')}</CardTitle>
          <RefreshButton onRefresh={refresh} loading={loading} />
        </CardHeader>
        {!loading && projects.length === 0 ? (
          <div className="text-center text-[var(--color-text-muted)] py-10 text-sm">
            <KanbanSquare className="h-6 w-6 mx-auto mb-3" />
            {t('projects.noProjects', 'No Projects Yet.')}
          </div>
        ) : (
          <div className="flex gap-2 flex-wrap">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => selectProject(p.number)}
                className={`px-3 py-1.5 rounded-md text-sm border ${selected === p.number ? 'border-[var(--color-accent)] font-medium' : 'border-[var(--color-border)]'}`}
              >
                #{p.number} {p.title} {p.status === 'closed' ? `(${t('projects.closed', 'Closed')})` : ''}
              </button>
            ))}
          </div>
        )}
      </Card>

      {board && (
        <Card>
          <CardHeader>
            <CardTitle>
              #{board.project.number} {board.project.title}
            </CardTitle>
            {canWrite && (
              <Button size="sm" onClick={() => void toggleStatus()}>
                {board.project.status === 'open'
                  ? t('projects.closeProject', 'Close Project')
                  : t('projects.reopenProject', 'Reopen Project')}
              </Button>
            )}
          </CardHeader>
          {canWrite && (
            <form onSubmit={submitColumn} className="flex gap-2 mb-4">
              <Input
                placeholder={t('projects.columnPlaceholder', 'New Column Title')}
                value={columnTitle}
                onChange={(e) => setColumnTitle(e.target.value)}
              />
              <Button type="submit" size="sm">
                {t('projects.addColumn', 'Add Column')}
              </Button>
            </form>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            {board.columns.map((col) => (
              <div key={col.id} className="rounded-md border border-[var(--color-border)] p-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-medium text-sm">{col.title}</h3>
                  {canWrite && board.columns.length > 1 && (
                    <div className="flex gap-1">
                      <Button size="sm" onClick={() => renameColumnPrompt(col.id, col.title)}>
                        {t('projects.renameColumn', 'Rename Column')}
                      </Button>
                      <Button size="sm" onClick={() => removeColumn(col.id)}>
                        {t('common.delete', 'Delete')}
                      </Button>
                    </div>
                  )}
                </div>
                <ul className="space-y-2">
                  {board.cards
                    .filter((c) => c.columnId === col.id && !c.archived)
                    .map((card) => (
                      <ProjectCardItem
                        key={card.id}
                        card={card}
                        columnTitles={board.columns.filter((c) => c.id !== col.id).map((c) => ({ id: c.id, title: c.title }))}
                        onMove={(toColumnId) => void moveCardTo(card.id, toColumnId)}
                        onArchive={() => archiveCard(card.id)}
                        onDelete={() => removeCard(card.id)}
                        moveLabel={(title) => `→ ${title}`}
                      />
                    ))}
                </ul>
                {canWrite && (
                  <form onSubmit={submitCard} className="mt-2 flex gap-1">
                    <Input
                      placeholder={t('projects.cardPlaceholder', 'New Card Title')}
                      value={activeColumn === col.id ? noteTitle : ''}
                      onFocus={() => setActiveColumn(col.id)}
                      onChange={(e) => {
                        setActiveColumn(col.id);
                        setNoteTitle(e.target.value);
                      }}
                    />
                    <Button type="submit" size="sm">
                      +
                    </Button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
