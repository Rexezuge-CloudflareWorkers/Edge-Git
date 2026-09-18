import { describe, expect, it } from 'vitest';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { mapRepoEventToWebhookEvent, WEBHOOK_EVENTS } from '@edge-git/backend-services/webhook/WebhookEvents';
import { DiscussionService } from '@edge-git/backend-services/discussion';
import { ProjectService } from '@edge-git/backend-services/project';
import { SearchService } from '@edge-git/backend-services/search';
import { SnippetService } from '@edge-git/backend-services/snippet';
import { WikiService } from '@edge-git/backend-services/wiki';
import { nextPosition, positionBetween, isValidPosition } from '../apps/web/src/lib/projectOrder';
import { isValidWikiSlug, normalizeWikiSlug, titleToSlug } from '../apps/web/src/lib/wikiSlug';

const env = { DB: {} as never };

function fakeProjectDAO(overrides: Record<string, (...args: never[]) => Promise<never>> = {}) {
  const columns = [
    { id: 'c1', project_id: 'p1', title: 'Todo', position: 0, created_at: 1 },
    { id: 'c2', project_id: 'p1', title: 'Done', position: 1, created_at: 2 },
  ];
  return {
    nextNumber: async () => 1,
    createProject: async () => undefined,
    listByRepo: async () => [],
    getByNumber: async () => ({
      id: 'p1',
      repository_id: 'r1',
      number: 1,
      title: 'T',
      description: null,
      status: 'open',
      creator_email: 'a@x.com',
      created_at: 1,
      updated_at: 1,
    }),
    getById: async () => ({
      id: 'p1',
      repository_id: 'r1',
      number: 1,
      title: 'T',
      description: null,
      status: 'open',
      creator_email: 'a@x.com',
      created_at: 1,
      updated_at: 1,
    }),
    countByRepo: async () => 0,
    setStatus: async () => undefined,
    updateProject: async () => undefined,
    deleteProject: async () => undefined,
    createColumn: async () => undefined,
    listColumns: async () => columns,
    getColumn: async (id: string) => columns.find((c) => c.id === id) ?? null,
    renameColumn: async () => undefined,
    deleteColumn: async () => undefined,
    createCard: async () => undefined,
    listCards: async () => [],
    getCard: async () => null,
    moveCard: async () => undefined,
    setCardArchived: async () => undefined,
    deleteCard: async () => undefined,
    countCardsInColumn: async () => 0,
    deleteByRepo: async () => undefined,
    ...overrides,
  };
}

describe('collab surfaces: projects', () => {
  it('creates a project with seeded-board defaults', async () => {
    const dao = fakeProjectDAO({
      getById: async () => ({
        id: 'p1',
        repository_id: 'r1',
        number: 1,
        title: 'Roadmap',
        description: null,
        status: 'open',
        creator_email: 'a@x.com',
        created_at: 1,
        updated_at: 1,
      }),
    }) as never;
    const svc = new ProjectService(env, { projectDAO: async () => dao });
    const project = await svc.createProject('r1', { title: '  Roadmap  ' }, 'A@x.com');
    expect(project.number).toBe(1);
    expect(project.title).toBe('Roadmap');
    expect(project.creatorEmail).toBe('a@x.com');
  });

  it('rejects blank titles and duplicate column names', async () => {
    const svc = new ProjectService(env, { projectDAO: async () => fakeProjectDAO() as never });
    await expect(svc.createProject('r1', { title: '   ' }, 'a@x.com')).rejects.toThrow('title is required');
    await expect(svc.createColumn('r1', 1, { title: 'todo' })).rejects.toThrow('a column with this title already exists');
  });

  it('enforces the per-repo project cap', async () => {
    const dao = fakeProjectDAO({ countByRepo: async () => 20 }) as never;
    const svc = new ProjectService({ DB: {} as never, MAX_PROJECTS_PER_REPO: '20' }, { projectDAO: async () => dao });
    await expect(svc.createProject('r1', { title: 'One More' }, 'a@x.com')).rejects.toThrow('Maximum 20 projects');
  });

  it('validates card kinds and payloads', async () => {
    const dao = fakeProjectDAO({
      getByNumber: async () => ({
        id: 'p1',
        repository_id: 'r1',
        number: 1,
        title: 'T',
        description: null,
        status: 'open',
        creator_email: 'a@x.com',
        created_at: 1,
        updated_at: 1,
      }),
    }) as never;
    const svc = new ProjectService(env, { projectDAO: async () => dao });
    await expect(svc.createCard('r1', 1, { columnId: 'c1', kind: 'nope' }, 'a@x.com')).rejects.toThrow('kind must be');
    await expect(svc.createCard('r1', 1, { columnId: 'missing', kind: 'note' }, 'a@x.com')).rejects.toThrow('unknown column');
    await expect(svc.createCard('r1', 1, { columnId: 'c1', kind: 'issue' }, 'a@x.com')).rejects.toThrow('issueId is required');
  });
});

describe('collab surfaces: discussions', () => {
  function discussionDAO(overrides: Record<string, (...args: never[]) => Promise<never>> = {}) {
    return {
      nextNumber: async () => 3,
      listCategories: async () => [],
      getCategoryBySlug: async () => null,
      getCategoryById: async () => null,
      createCategory: async () => undefined,
      ensureDefaultCategories: async () => [],
      createDiscussion: async () => undefined,
      listByRepo: async () => [],
      getByNumber: async () => null,
      getById: async () => null,
      countByRepo: async () => 0,
      setStatus: async () => undefined,
      updateDiscussion: async () => undefined,
      deleteDiscussion: async () => undefined,
      createComment: async () => undefined,
      listComments: async () => [],
      getComment: async () => null,
      updateComment: async () => undefined,
      deleteComment: async () => undefined,
      deleteByRepo: async () => undefined,
      ...overrides,
    };
  }

  it('numbers new discussions per repo', async () => {
    const dao = discussionDAO({
      getByNumber: async () => ({
        id: 'd3',
        repository_id: 'r1',
        category_id: null,
        number: 3,
        title: 'Hello',
        body: null,
        author_email: 'a@x.com',
        status: 'open',
        created_at: 1,
        updated_at: 1,
      }),
    }) as never;
    const svc = new DiscussionService(env, { discussionDAO: async () => dao });
    const discussion = await svc.createDiscussion('r1', { title: 'Hello' }, 'A@X.com');
    expect(discussion.number).toBe(3);
    expect(discussion.authorEmail).toBe('a@x.com');
  });

  it('rejects unknown categories and bad statuses', async () => {
    const svc = new DiscussionService(env, { discussionDAO: async () => discussionDAO() as never });
    await expect(svc.createDiscussion('r1', { title: 'T', categorySlug: 'nope' }, 'a@x.com')).rejects.toThrow('unknown category');
    await expect(svc.setStatus('r1', 1, 'archived')).rejects.toThrow('status must be');
  });

  it('blocks comments on locked discussions', async () => {
    const dao = discussionDAO({
      getByNumber: async () => ({
        id: 'd1',
        repository_id: 'r1',
        category_id: null,
        number: 1,
        title: 'T',
        body: null,
        author_email: 'a@x.com',
        status: 'locked',
        created_at: 1,
        updated_at: 1,
      }),
    }) as never;
    const svc = new DiscussionService(env, { discussionDAO: async () => dao });
    await expect(svc.addComment('r1', 1, { body: 'hi' }, 'b@x.com')).rejects.toThrow('locked');
  });
});

describe('collab surfaces: wiki', () => {
  function wikiDAO(overrides: Record<string, (...args: never[]) => Promise<never>> = {}) {
    return {
      createPage: async () => undefined,
      listByRepo: async () => [],
      getBySlug: async () => null,
      countByRepo: async () => 0,
      updatePage: async () => ({
        id: 'w1',
        repository_id: 'r1',
        slug: 'home',
        title: 'Home',
        body: 'v2',
        revision: 2,
        updated_by: 'a@x.com',
        created_at: 1,
        updated_at: 2,
      }),
      deletePage: async () => undefined,
      listRevisions: async () => [],
      searchByRepo: async () => [],
      deleteByRepo: async () => undefined,
      ...overrides,
    };
  }

  it('validates slugs and titles on create', async () => {
    const svc = new WikiService(env, { wikiDAO: async () => wikiDAO() as never });
    await expect(svc.createPage('r1', { slug: 'Bad Slug!!', title: 'T' }, 'a@x.com')).rejects.toThrow('slug must be');
    await expect(svc.createPage('r1', { slug: 'home', title: '' }, 'a@x.com')).rejects.toThrow('title is required');
  });

  it('surfaces revision conflicts for routes to map to 409', async () => {
    const dao = wikiDAO({
      getBySlug: async () => ({
        id: 'w1',
        repository_id: 'r1',
        slug: 'home',
        title: 'Home',
        body: 'v1',
        revision: 2,
        updated_by: 'a@x.com',
        created_at: 1,
        updated_at: 1,
      }),
      updatePage: async () => {
        throw new Error('revision conflict: expected 1 but found 2');
      },
    }) as never;
    const svc = new WikiService(env, { wikiDAO: async () => dao });
    const error = await svc.updatePage('r1', 'home', { body: 'stale', expectedRevision: 1 }, 'b@x.com').catch((e: Error) => e);
    expect(error.message).toMatch('revision conflict');
  });

  it('normalizes titles to slugs', () => {
    expect(titleToSlug('Hello, World!')).toBe('hello-world');
    expect(titleToSlug('   ')).toBe('untitled');
    expect(isValidWikiSlug('home')).toBe(true);
    expect(isValidWikiSlug('Bad_Slug')).toBe(false);
    expect(normalizeWikiSlug('  A--B  ')).toBe('a-b');
  });
});

describe('collab surfaces: snippets', () => {
  function snippetDAO(overrides: Record<string, (...args: never[]) => Promise<never>> = {}) {
    return {
      createSnippet: async () => undefined,
      addFile: async () => undefined,
      getById: async () => null,
      listByOwner: async () => [],
      listPublic: async () => [],
      countByOwner: async () => 0,
      listFiles: async () => [],
      updateSnippet: async () => undefined,
      replaceFiles: async () => undefined,
      deleteSnippet: async () => undefined,
      searchPublic: async () => [],
      ...overrides,
    };
  }

  it('requires files and validates filenames', async () => {
    const svc = new SnippetService(env, { snippetDAO: async () => snippetDAO() as never });
    await expect(svc.createSnippet('a@x.com', { files: [] })).rejects.toThrow('non-empty array');
    await expect(svc.createSnippet('a@x.com', { files: [{ filename: '../evil', body: 'x' }] })).rejects.toThrow('invalid filename');
    await expect(
      svc.createSnippet('a@x.com', {
        files: [
          { filename: 'a.txt', body: 'x' },
          { filename: 'A.TXT', body: 'y' },
        ],
      }),
    ).rejects.toThrow('duplicate filename');
  });

  it('hides secret snippets from non-owners', async () => {
    const dao = snippetDAO({
      getById: async () => ({ id: 's1', owner_email: 'owner@x.com', title: 'T', visibility: 'secret', created_at: 1, updated_at: 1 }),
    }) as never;
    const svc = new SnippetService(env, { snippetDAO: async () => dao });
    await expect(svc.getSnippet('s1', 'stranger@x.com')).rejects.toThrow('Snippet not found');
    await expect(svc.getSnippet('s1', null)).rejects.toThrow('Snippet not found');
  });

  it('enforces the per-user snippet cap', async () => {
    const dao = snippetDAO({ countByOwner: async () => 100 }) as never;
    const svc = new SnippetService({ DB: {} as never, MAX_SNIPPETS_PER_USER: '100' }, { snippetDAO: async () => dao });
    await expect(svc.createSnippet('a@x.com', { files: [{ filename: 'a.txt', body: 'x' }] })).rejects.toThrow('Maximum 100 snippets');
  });
});

describe('collab surfaces: search + webhooks + config', () => {
  it('parses the new search types', () => {
    expect(SearchService.parseType('discussions')).toBe('discussions');
    expect(SearchService.parseType('snippets')).toBe('snippets');
    expect(SearchService.parseType('unknown')).toBe('repos');
    expect(SearchService.clampLimit('999')).toBe(50);
  });

  it('exposes the new webhook events and maps repo events', () => {
    for (const event of ['project', 'discussion', 'discussion_comment', 'wiki', 'snippet'] as const) {
      expect(WEBHOOK_EVENTS).toContain(event);
    }
    expect(mapRepoEventToWebhookEvent('project_created')).toBe('project');
    expect(mapRepoEventToWebhookEvent('discussion_commented')).toBe('discussion_comment');
    expect(mapRepoEventToWebhookEvent('wiki_updated')).toBe('wiki');
    expect(mapRepoEventToWebhookEvent('snippet_created')).toBe('snippet');
  });

  it('reads the new limits from env with defaults', () => {
    expect(ConfigurationManager.collabSurfaces.getMaxProjectsPerRepo({})).toBe(20);
    expect(ConfigurationManager.collabSurfaces.getMaxColumnsPerProject({})).toBe(10);
    expect(ConfigurationManager.collabSurfaces.getMaxWikiPagesPerRepo({})).toBe(100);
    expect(ConfigurationManager.collabSurfaces.getMaxSnippetsPerUser({})).toBe(100);
    expect(ConfigurationManager.collabSurfaces.getMaxProjectsPerRepo({ MAX_PROJECTS_PER_REPO: '3' })).toBe(3);
  });
});

describe('collab surfaces: web helpers', () => {
  it('computes board positions', () => {
    expect(nextPosition([])).toBe(0);
    expect(nextPosition([0, 2])).toBe(3);
    expect(positionBetween(null, null)).toBe(0);
    expect(positionBetween(null, 4)).toBe(3);
    expect(positionBetween(2, null)).toBe(3);
    expect(positionBetween(1, 3)).toBe(2);
    expect(isValidPosition(1.5)).toBe(true);
    expect(isValidPosition(Number.NaN)).toBe(false);
  });
});
