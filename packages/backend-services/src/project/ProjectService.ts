import { ProjectDAO } from '@edge-git/backend-data/dao';
import type { ProjectCardRow, ProjectColumnRow, ProjectRow } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError, NotFoundError } from '@edge-git/backend-errors';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import type { ProjectCardMetadata, ProjectColumnMetadata, ProjectMetadata } from '@edge-git/shared';
import { TimestampUtil, UUIDUtil } from '@edge-git/shared/utils';

interface ProjectServiceEnv {
  DB: D1Queryable;
  MAX_PROJECTS_PER_REPO?: string;
  MAX_COLUMNS_PER_PROJECT?: string;
  MAX_CARDS_PER_COLUMN?: string;
}

interface ProjectServiceDeps {
  projectDAO?: () => Promise<ProjectDAO>;
}

const MAX_TITLE = 100;
const MAX_DESCRIPTION = 1000;
const MAX_NOTE_TITLE = 200;
const MAX_NOTE_BODY = 10_000;

function toMetadata(row: ProjectRow): ProjectMetadata {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    number: row.number,
    title: row.title,
    description: row.description,
    status: row.status as ProjectMetadata['status'],
    creatorEmail: row.creator_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toColumnMetadata(row: ProjectColumnRow): ProjectColumnMetadata {
  return { id: row.id, projectId: row.project_id, title: row.title, position: row.position, createdAt: row.created_at };
}

function toCardMetadata(row: ProjectCardRow): ProjectCardMetadata {
  return {
    id: row.id,
    projectId: row.project_id,
    columnId: row.column_id,
    kind: row.kind as ProjectCardMetadata['kind'],
    noteTitle: row.note_title,
    noteBody: row.note_body,
    issueId: row.issue_id,
    pullRequestId: row.pull_request_id,
    position: row.position,
    archived: row.archived === 1,
    creatorEmail: row.creator_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTitle(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new BadRequestError('title is required');
  const title = raw.trim();
  if (title.length > MAX_TITLE) throw new BadRequestError(`title must be at most ${MAX_TITLE} characters`);
  return title;
}

class ProjectService {
  private readonly deps: Required<ProjectServiceDeps>;

  constructor(
    private readonly env: ProjectServiceEnv,
    deps: ProjectServiceDeps = {},
  ) {
    this.deps = {
      projectDAO: () => Promise.resolve(new ProjectDAO(env.DB)),
      ...deps,
    };
  }

  public async createProject(
    repositoryId: string,
    input: { title: unknown; description?: unknown },
    creatorEmail: string,
  ): Promise<ProjectMetadata> {
    const title = normalizeTitle(input.title);
    const description =
      input.description === undefined || input.description === null
        ? null
        : typeof input.description === 'string'
          ? input.description.trim().slice(0, MAX_DESCRIPTION) || null
          : (() => {
              throw new BadRequestError('description must be a string');
            })();
    const dao = await this.deps.projectDAO();
    const max = ConfigurationManager.collabSurfaces.getMaxProjectsPerRepo(this.env);
    const count = await dao.countByRepo(repositoryId).catch(() => 0);
    if (count >= max) throw new BadRequestError(`Maximum ${max} projects per repository`);
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const id = UUIDUtil.getRandomUUID();
    const number = await dao.nextNumber(repositoryId);
    await dao.createProject({ id, repositoryId, number, title, description, creatorEmail: creatorEmail.toLowerCase(), now });
    // Seed the canonical three columns so boards are usable immediately.
    const seeds: Array<{ title: string; position: number }> = [
      { title: 'Todo', position: 0 },
      { title: 'In Progress', position: 1 },
      { title: 'Done', position: 2 },
    ];
    for (const seed of seeds) {
      await dao
        .createColumn({ id: UUIDUtil.getRandomUUID(), projectId: id, title: seed.title, position: seed.position, now })
        .catch(() => undefined);
    }
    const row = await dao.getById(id, repositoryId);
    if (!row) throw new NotFoundError('Project not found');
    return toMetadata(row);
  }

  public async listProjects(repositoryId: string): Promise<ProjectMetadata[]> {
    const dao = await this.deps.projectDAO();
    const rows = await dao.listByRepo(repositoryId).catch(() => []);
    return rows.map(toMetadata);
  }

  public async getProject(repositoryId: string, number: number): Promise<ProjectMetadata> {
    const dao = await this.deps.projectDAO();
    const row = await dao.getByNumber(repositoryId, number);
    if (!row) throw new NotFoundError('Project not found');
    return toMetadata(row);
  }

  public async getProjectBoard(
    repositoryId: string,
    number: number,
  ): Promise<{ project: ProjectMetadata; columns: ProjectColumnMetadata[]; cards: ProjectCardMetadata[] }> {
    const dao = await this.deps.projectDAO();
    const row = await dao.getByNumber(repositoryId, number);
    if (!row) throw new NotFoundError('Project not found');
    const [columns, cards] = await Promise.all([dao.listColumns(row.id), dao.listCards(row.id)]);
    return { project: toMetadata(row), columns: columns.map(toColumnMetadata), cards: cards.map(toCardMetadata) };
  }

  public async updateProject(
    repositoryId: string,
    number: number,
    input: { title?: unknown; description?: unknown },
  ): Promise<ProjectMetadata> {
    const dao = await this.deps.projectDAO();
    const row = await dao.getByNumber(repositoryId, number);
    if (!row) throw new NotFoundError('Project not found');
    const patch: { title?: string; description?: string | null } = {};
    if (input.title !== undefined) patch.title = normalizeTitle(input.title);
    if (input.description !== undefined) {
      if (input.description !== null && typeof input.description !== 'string') throw new BadRequestError('description must be a string');
      patch.description = input.description === null ? null : input.description.trim().slice(0, MAX_DESCRIPTION) || null;
    }
    await dao.updateProject(row.id, repositoryId, patch, TimestampUtil.getCurrentUnixTimestampInSeconds());
    const updated = await dao.getByNumber(repositoryId, number);
    if (!updated) throw new NotFoundError('Project not found');
    return toMetadata(updated);
  }

  public async setStatus(repositoryId: string, number: number, status: unknown): Promise<ProjectMetadata> {
    if (status !== 'open' && status !== 'closed') throw new BadRequestError('status must be open or closed');
    const dao = await this.deps.projectDAO();
    const row = await dao.getByNumber(repositoryId, number);
    if (!row) throw new NotFoundError('Project not found');
    await dao.setStatus(row.id, repositoryId, status, TimestampUtil.getCurrentUnixTimestampInSeconds());
    const updated = await dao.getByNumber(repositoryId, number);
    if (!updated) throw new NotFoundError('Project not found');
    return toMetadata(updated);
  }

  public async deleteProject(repositoryId: string, number: number): Promise<{ id: string }> {
    const dao = await this.deps.projectDAO();
    const row = await dao.getByNumber(repositoryId, number);
    if (!row) throw new NotFoundError('Project not found');
    await dao.deleteProject(row.id, repositoryId);
    return { id: row.id };
  }

  public async createColumn(repositoryId: string, projectNumber: number, input: { title: unknown }): Promise<ProjectColumnMetadata> {
    const title = normalizeTitle(input.title);
    const dao = await this.deps.projectDAO();
    const project = await dao.getByNumber(repositoryId, projectNumber);
    if (!project) throw new NotFoundError('Project not found');
    const existing = await dao.listColumns(project.id);
    const max = ConfigurationManager.collabSurfaces.getMaxColumnsPerProject(this.env);
    if (existing.length >= max) throw new BadRequestError(`Maximum ${max} columns per project`);
    if (existing.some((c) => c.title.toLowerCase() === title.toLowerCase()))
      throw new BadRequestError('a column with this title already exists');
    const position = existing.length === 0 ? 0 : Math.max(...existing.map((c) => c.position)) + 1;
    const id = UUIDUtil.getRandomUUID();
    try {
      await dao.createColumn({ id, projectId: project.id, title, position, now: TimestampUtil.getCurrentUnixTimestampInSeconds() });
    } catch {
      throw new BadRequestError('a column with this title already exists');
    }
    const row = await dao.getColumn(id, project.id);
    if (!row) throw new NotFoundError('Project column not found');
    return toColumnMetadata(row);
  }

  public async renameColumn(
    repositoryId: string,
    projectNumber: number,
    columnId: string,
    input: { title: unknown },
  ): Promise<ProjectColumnMetadata> {
    const title = normalizeTitle(input.title);
    const dao = await this.deps.projectDAO();
    const project = await dao.getByNumber(repositoryId, projectNumber);
    if (!project) throw new NotFoundError('Project not found');
    const column = await dao.getColumn(columnId, project.id);
    if (!column) throw new NotFoundError('Project column not found');
    const siblings = await dao.listColumns(project.id);
    if (siblings.some((c) => c.id !== columnId && c.title.toLowerCase() === title.toLowerCase()))
      throw new BadRequestError('a column with this title already exists');
    try {
      await dao.renameColumn(columnId, project.id, title);
    } catch {
      throw new BadRequestError('a column with this title already exists');
    }
    const updated = await dao.getColumn(columnId, project.id);
    if (!updated) throw new NotFoundError('Project column not found');
    return toColumnMetadata(updated);
  }

  public async deleteColumn(repositoryId: string, projectNumber: number, columnId: string): Promise<{ id: string }> {
    const dao = await this.deps.projectDAO();
    const project = await dao.getByNumber(repositoryId, projectNumber);
    if (!project) throw new NotFoundError('Project not found');
    const column = await dao.getColumn(columnId, project.id);
    if (!column) throw new NotFoundError('Project column not found');
    const columns = await dao.listColumns(project.id);
    if (columns.length <= 1) throw new BadRequestError('a project must keep at least one column');
    await dao.deleteColumn(columnId, project.id);
    return { id: columnId };
  }

  public async createCard(
    repositoryId: string,
    projectNumber: number,
    input: { columnId: unknown; kind?: unknown; noteTitle?: unknown; noteBody?: unknown; issueId?: unknown; pullRequestId?: unknown },
    creatorEmail: string,
  ): Promise<ProjectCardMetadata> {
    if (typeof input.columnId !== 'string' || !input.columnId) throw new BadRequestError('columnId is required');
    const kind = input.kind === undefined ? 'note' : input.kind;
    if (kind !== 'note' && kind !== 'issue' && kind !== 'pull') throw new BadRequestError('kind must be note, issue, or pull');
    const dao = await this.deps.projectDAO();
    const project = await dao.getByNumber(repositoryId, projectNumber);
    if (!project) throw new NotFoundError('Project not found');
    const column = await dao.getColumn(input.columnId, project.id);
    if (!column) throw new BadRequestError('unknown column');
    const max = ConfigurationManager.collabSurfaces.getMaxCardsPerColumn(this.env);
    const count = await dao.countCardsInColumn(column.id).catch(() => 0);
    if (count >= max) throw new BadRequestError(`Maximum ${max} cards per column`);
    let noteTitle: string | null = null;
    let noteBody: string | null = null;
    let issueId: string | null = null;
    let pullRequestId: string | null = null;
    if (kind === 'note') {
      if (input.noteTitle === undefined) {
        noteTitle = 'Untitled';
      } else {
        if (typeof input.noteTitle !== 'string' || !input.noteTitle.trim())
          throw new BadRequestError('noteTitle must be a non-empty string');
        noteTitle = input.noteTitle.trim().slice(0, MAX_NOTE_TITLE);
      }
      if (input.noteBody !== undefined) {
        if (typeof input.noteBody !== 'string') throw new BadRequestError('noteBody must be a string');
        noteBody = input.noteBody.slice(0, MAX_NOTE_BODY) || null;
      }
    } else if (kind === 'issue') {
      if (typeof input.issueId !== 'string' || !input.issueId) throw new BadRequestError('issueId is required for issue cards');
      issueId = input.issueId;
    } else {
      if (typeof input.pullRequestId !== 'string' || !input.pullRequestId)
        throw new BadRequestError('pullRequestId is required for pull cards');
      pullRequestId = input.pullRequestId;
    }
    const siblings = await dao.listCards(project.id, true).catch(() => []);
    const columnSiblings = siblings.filter((c) => c.column_id === column.id);
    const position = columnSiblings.length === 0 ? 0 : Math.max(...columnSiblings.map((c) => c.position)) + 1;
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const id = UUIDUtil.getRandomUUID();
    await dao.createCard({
      id,
      projectId: project.id,
      columnId: column.id,
      kind,
      noteTitle,
      noteBody,
      issueId,
      pullRequestId,
      position,
      creatorEmail: creatorEmail.toLowerCase(),
      now,
    });
    const row = await dao.getCard(id, project.id);
    if (!row) throw new NotFoundError('Project card not found');
    return toCardMetadata(row);
  }

  public async moveCard(
    repositoryId: string,
    projectNumber: number,
    cardId: string,
    input: { toColumnId: unknown; position?: unknown },
  ): Promise<ProjectCardMetadata> {
    if (typeof input.toColumnId !== 'string' || !input.toColumnId) throw new BadRequestError('toColumnId is required');
    const dao = await this.deps.projectDAO();
    const project = await dao.getByNumber(repositoryId, projectNumber);
    if (!project) throw new NotFoundError('Project not found');
    const card = await dao.getCard(cardId, project.id);
    if (!card) throw new NotFoundError('Project card not found');
    const target = await dao.getColumn(input.toColumnId, project.id);
    if (!target) throw new BadRequestError('unknown target column');
    let position: number;
    if (input.position === undefined) {
      const siblings = await dao.listCards(project.id, true).catch(() => []);
      const inTarget = siblings.filter((c) => c.column_id === target.id && c.id !== card.id);
      position = inTarget.length === 0 ? 0 : Math.max(...inTarget.map((c) => c.position)) + 1;
    } else {
      if (typeof input.position !== 'number' || !Number.isFinite(input.position)) throw new BadRequestError('position must be a number');
      position = input.position;
    }
    await dao.moveCard(card.id, project.id, target.id, position, TimestampUtil.getCurrentUnixTimestampInSeconds());
    const updated = await dao.getCard(card.id, project.id);
    if (!updated) throw new NotFoundError('Project card not found');
    return toCardMetadata(updated);
  }

  public async setCardArchived(
    repositoryId: string,
    projectNumber: number,
    cardId: string,
    archived: unknown,
  ): Promise<ProjectCardMetadata> {
    if (typeof archived !== 'boolean') throw new BadRequestError('archived must be a boolean');
    const dao = await this.deps.projectDAO();
    const project = await dao.getByNumber(repositoryId, projectNumber);
    if (!project) throw new NotFoundError('Project not found');
    const card = await dao.getCard(cardId, project.id);
    if (!card) throw new NotFoundError('Project card not found');
    await dao.setCardArchived(card.id, project.id, archived, TimestampUtil.getCurrentUnixTimestampInSeconds());
    const updated = await dao.getCard(card.id, project.id);
    if (!updated) throw new NotFoundError('Project card not found');
    return toCardMetadata(updated);
  }

  public async deleteCard(repositoryId: string, projectNumber: number, cardId: string): Promise<{ id: string }> {
    const dao = await this.deps.projectDAO();
    const project = await dao.getByNumber(repositoryId, projectNumber);
    if (!project) throw new NotFoundError('Project not found');
    const card = await dao.getCard(cardId, project.id);
    if (!card) throw new NotFoundError('Project card not found');
    await dao.deleteCard(card.id, project.id);
    return { id: cardId };
  }
}

export { ProjectService };
export type { ProjectServiceDeps, ProjectServiceEnv };
