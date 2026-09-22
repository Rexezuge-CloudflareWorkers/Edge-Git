import type { ProjectCard } from '../../types';
import { Button } from '../ui/Button';

export interface ProjectCardItemProps {
  card: ProjectCard;
  columnTitles: Array<{ id: string; title: string }>;
  onMove: (toColumnId: string) => void;
  onArchive: () => void;
  onDelete: () => void;
  moveLabel: (title: string) => string;
}

/**
 * Single Kanban card (pure presentational), extracted from `ProjectsTab`.
 */
export function ProjectCardItem({ card, columnTitles, onMove, onArchive, onDelete, moveLabel }: ProjectCardItemProps) {
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
