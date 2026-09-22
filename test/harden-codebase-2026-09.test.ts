import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';
// NOTE: relative imports bypass package barrels that re-export the `dofs`
// runtime (unparsable in the node unit pool).
import { parseBlobFilter, shouldSkipBlob } from '../packages/git-service/src/PackFilter';
import { RefService } from '../packages/git-service/src/RefService';
import {
  isHookSubscribed,
  resolveSenderUsername,
  toPublicDelivery,
} from '../packages/backend-services/src/webhook/WebhookDeliveryMapping';
import {
  PROFILE_REPO_SCAN_CAP,
  filterVisibleRepos,
  hasVisibleRepo,
  parseLimit,
} from '../apps/api/src/workers/routes/UserProfileVisibility';
import { latestReviewsByAuthor } from '../apps/web/src/lib/threads';
import * as orgModule from '../packages/backend-services/src/org/OrganizationService';
import * as teamModule from '../packages/backend-services/src/team/TeamService';
import { registerSearchRoutes } from '../apps/api/src/workers/routes/SearchRoutes';

describe('harden: PackFilter pure policy', () => {
  it('parses blob:none, blob:limit, and empty filters', () => {
    expect(parseBlobFilter('blob:none')).toEqual({ filterBlobs: true, blobLimit: undefined });
    expect(parseBlobFilter('blob:limit=1024')).toEqual({ filterBlobs: false, blobLimit: 1024 });
    expect(parseBlobFilter('')).toEqual({ filterBlobs: false, blobLimit: undefined });
    expect(parseBlobFilter('tree:0')).toEqual({ filterBlobs: false, blobLimit: undefined });
  });

  it('skips blobs per filter (mirrors PackCollector behavior)', () => {
    expect(shouldSkipBlob(10, parseBlobFilter('blob:none'))).toBe(true);
    expect(shouldSkipBlob(2048, parseBlobFilter('blob:limit=1024'))).toBe(true);
    expect(shouldSkipBlob(512, parseBlobFilter('blob:limit=1024'))).toBe(false);
    expect(shouldSkipBlob(1_000_000, parseBlobFilter(''))).toBe(false);
  });
});

describe('harden: WebhookDeliveryMapping pure policy', () => {
  it('maps delivery rows to public metadata with status normalization', () => {
    const base = {
      id: 'd1',
      hook_id: 'h1',
      repository_id: 'r1',
      event: 'push',
      event_id: 'e1',
      attempts: 2,
      next_retry_at: 7,
      last_http_status: 500,
      last_error: 'boom',
      created_at: 1,
      updated_at: 2,
      payload: '{}',
    } as never;
    expect(toPublicDelivery({ ...base, status: 'success' }).status).toBe('success');
    expect(toPublicDelivery({ ...base, status: 'failed' }).status).toBe('failed');
    expect(toPublicDelivery({ ...base, status: 'pending' }).status).toBe('pending');
    expect(toPublicDelivery({ ...base, status: 'weird' }).status).toBe('pending');
  });

  it('matches hooks by active flag and subscribed event', () => {
    const active = { is_active: 1, events: JSON.stringify(['push', 'ping']) } as never;
    expect(isHookSubscribed(active, 'push' as never)).toBe(true);
    expect(isHookSubscribed(active, 'issues' as never)).toBe(false);
    expect(isHookSubscribed({ is_active: 0, events: JSON.stringify(['push']) } as never, 'push' as never)).toBe(false);
    expect(isHookSubscribed({ is_active: 1, events: 'not-json' } as never, 'push' as never)).toBe(false);
  });

  it('resolves sender username with legacy email fallback', () => {
    expect(resolveSenderUsername('alice')).toBe('alice');
    expect(resolveSenderUsername(undefined, 'ALICE@Example.COM')).toBe('alice@example.com');
    expect(resolveSenderUsername()).toBe('ghost');
  });
});

describe('harden: UserProfileVisibility helpers', () => {
  it('parseLimit keeps the safe-default/clamp contract', () => {
    expect(parseLimit('https://x/?limit=abc')).toBe(20);
    expect(parseLimit('https://x/?limit=500')).toBe(100);
    expect(parseLimit('https://x/?limit=0')).toBe(1);
    expect(parseLimit('not a url')).toBe(20);
  });

  it('filterVisibleRepos caps the scan and hides failures', async () => {
    const rows = Array.from({ length: PROFILE_REPO_SCAN_CAP + 50 }, (_, i) => ({ id: `r${i}` }) as never);
    const visible = await filterVisibleRepos(rows, async () => 'read', 10);
    expect(visible).toHaveLength(10);
    const hidden = await filterVisibleRepos([{ id: 'r1' } as never], async () => Promise.reject(new Error('D1 down')), 10);
    expect(hidden).toEqual([]);
  });

  it('hasVisibleRepo fails closed on role errors', async () => {
    expect(await hasVisibleRepo([], async () => 'read')).toBe(false);
    expect(await hasVisibleRepo([{ id: 'r1' } as never], async () => Promise.reject(new Error('D1 down')))).toBe(false);
    expect(await hasVisibleRepo([{ id: 'r1' } as never], async () => 'read')).toBe(true);
  });
});

describe('harden: RefService honors the injected gitdir', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('reads HEAD from the custom gitdir (no hardcoded /repo/HEAD)', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-harden-gitdir-'));
    tmpDirs.push(dir);
    const bareAt = path.join(dir, 'custom.git');
    const svc = new RefService(fs as never, bareAt);
    await svc.initRepo();
    const listed = await new RefService(fs as never, bareAt).listRefs();
    expect(listed.symbolicHead).toBe('refs/heads/main');
    expect(listed.refs).toEqual([]);
  });

  it('resolves symbolic HEAD on a committed custom-gitdir repo', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-harden-gitdir2-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'hi\n');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const oid = await git.commit({ fs, dir, author: { name: 't', email: 't@example.com' }, message: 'init' });
    const listed = await new RefService(fs as never, path.join(dir, '.git')).listRefs();
    expect(listed.symbolicHead).toBe('refs/heads/master');
    expect(listed.refs.find((r) => r.ref === 'HEAD')?.oid).toBe(oid);
  });
});

describe('harden: orphan removal', () => {
  it('drops the ORG_NAME_RE / TEAM_SLUG_RE compat aliases', () => {
    expect('ORG_NAME_RE' in orgModule).toBe(false);
    expect('TEAM_SLUG_RE' in teamModule).toBe(false);
  });

  it('web gate keys reviews by author only (no legacy email fallback)', () => {
    const legacy = { author: '', author_email: 'ghost@example.com', state: 'approved' } as unknown as Parameters<
      typeof latestReviewsByAuthor
    >[0][number];
    expect(latestReviewsByAuthor([legacy]).has('')).toBe(true);
    expect(latestReviewsByAuthor([legacy]).has('ghost@example.com')).toBe(false);
  });
});

describe('harden: repo-scoped snippet search returns empty', () => {
  it('does not leak the global snippet list into a repo context', async () => {
    const publicRow = {
      id: 'repo-1',
      owner: 'alice',
      name: 'demo',
      owner_type: 'user',
      org_id: null,
      description: null,
      is_private: 0,
      forked_from_full_name: null,
      created_at: 1,
      updated_at: 2,
    };
    const fakeDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ ...publicRow }),
          all: async () => ({ results: [] }),
          run: async () => ({}),
        }),
      }),
    };
    const seen: unknown[] = [];
    const handlers = new Map<string, (c: never) => Promise<unknown>>();
    const app = { get: (routePath: string, handler: (c: never) => Promise<unknown>) => void handlers.set(routePath, handler) };
    registerSearchRoutes(app as never);
    const handler = handlers.get('/search');
    expect(handler).toBeTypeOf('function');
    const url = 'https://x/search?q=hello&type=snippets&owner=alice&repo=demo';
    const fakeCtx = {
      req: { url, raw: new Request(url) },
      env: { DB: fakeDb },
      get: (_key: string) => {
        throw new Error('no scope');
      },
      json: (body: unknown) => {
        seen.push(body);
        return Response.json(body);
      },
    };
    await handler?.(fakeCtx as never);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'snippets', query: 'hello', snippets: [] });
  });
});
