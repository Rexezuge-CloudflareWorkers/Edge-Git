import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KanbanSquare } from 'lucide-react';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { ProjectCardItem } from './ProjectCardItem';
import { useProjects } from './useProjects';
import { useProjectBoard } from './useProjectBoard';

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
  const { projects, selected, setSelected, loading, saving, refresh, create } = useProjects({
    owner,
    repo,
    authorized,
    showNotice,
  });
  const boardHook = useProjectBoard({
    owner,
    repo,
    selected,
    authorized,
    showNotice,
    onProjectStatusChanged: refresh,
  });
  const { board } = boardHook;
  const [title, setTitle] = useState('');

  const selectProject = (number: number) => {
    boardHook.clearBoard();
    setSelected(number);
  };

  const submitProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const created = await create(title);
    if (created !== null) {
      boardHook.clearBoard();
      setTitle('');
    }
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
              <Button size="sm" onClick={() => void boardHook.toggleStatus()}>
                {board.project.status === 'open'
                  ? t('projects.closeProject', 'Close Project')
                  : t('projects.reopenProject', 'Reopen Project')}
              </Button>
            )}
          </CardHeader>
          {canWrite && (
            <form onSubmit={boardHook.submitColumn} className="flex gap-2 mb-4">
              <Input
                placeholder={t('projects.columnPlaceholder', 'New Column Title')}
                value={boardHook.columnTitle}
                onChange={(e) => boardHook.setColumnTitle(e.target.value)}
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
                      <Button size="sm" onClick={() => boardHook.renameColumnPrompt(col.id, col.title)}>
                        {t('projects.renameColumn', 'Rename Column')}
                      </Button>
                      <Button size="sm" onClick={() => boardHook.removeColumn(col.id)}>
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
                        onMove={(toColumnId) => void boardHook.moveCardTo(card.id, toColumnId)}
                        onArchive={() => boardHook.archiveCard(card.id)}
                        onDelete={() => boardHook.removeCard(card.id)}
                        moveLabel={(title) => `→ ${title}`}
                      />
                    ))}
                </ul>
                {canWrite && (
                  <form onSubmit={boardHook.submitCard} className="mt-2 flex gap-1">
                    <Input
                      placeholder={t('projects.cardPlaceholder', 'New Card Title')}
                      value={boardHook.activeColumn === col.id ? boardHook.noteTitle : ''}
                      onFocus={() => boardHook.setActiveColumn(col.id)}
                      onChange={(e) => {
                        boardHook.setActiveColumn(col.id);
                        boardHook.setNoteTitle(e.target.value);
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
