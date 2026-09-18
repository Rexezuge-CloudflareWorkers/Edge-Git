import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationManager } from '@edge-git/backend-runtime/config/ConfigurationManager';
import { AppConfiguration } from '@edge-git/backend-runtime/config/AppConfiguration';
import {
  buildFetchErrorResponse,
  parseFetchRequest,
  validateFetchRequestCounts,
  validateReceivePackCounts,
} from '@edge-git/git-protocol';
// NOTE: relative import bypasses packages/git-service/src/index.ts, which
// re-exports the `dofs` runtime (unparsable in the node test env).
import { GitService, PackLimitError } from '../packages/git-service/src/GitService';

const OID = 'a'.repeat(40);

describe('git limit configuration', () => {
  it('exposes new repo limits via manager and app config', () => {
    const env = {
      MAX_FETCH_WANTS: '7',
      MAX_FETCH_HAVES: '9',
      MAX_PUSH_COMMANDS: '11',
      MAX_PACK_BYTES: '13',
      MAX_FETCH_BODY_BYTES: '17',
    };
    expect(ConfigurationManager.repo.getMaxFetchWants(env)).toBe(7);
    expect(ConfigurationManager.repo.getMaxFetchHaves(env)).toBe(9);
    expect(ConfigurationManager.repo.getMaxPushCommands(env)).toBe(11);
    expect(ConfigurationManager.repo.getMaxPackBytes(env)).toBe(13);
    expect(ConfigurationManager.repo.getMaxFetchBodyBytes(env)).toBe(17);
    const app = AppConfiguration.fromEnv(env);
    expect(app.getMaxFetchWants()).toBe(7);
    expect(app.getMaxFetchHaves()).toBe(9);
    expect(app.getMaxPushCommands()).toBe(11);
    expect(app.getMaxPackBytes()).toBe(13);
    expect(app.getMaxFetchBodyBytes()).toBe(17);
  });

  it('falls back to defaults for missing limit env', () => {
    const env = {};
    expect(ConfigurationManager.repo.getMaxFetchWants(env)).toBe(64);
    expect(ConfigurationManager.repo.getMaxFetchHaves(env)).toBe(512);
    expect(ConfigurationManager.repo.getMaxPushCommands(env)).toBe(100);
    expect(ConfigurationManager.repo.getMaxPackBytes(env)).toBe(52_428_800);
    expect(ConfigurationManager.repo.getMaxFetchBodyBytes(env)).toBe(1_048_576);
  });

  it('falls back to defaults for invalid limit env', () => {
    const env = { MAX_FETCH_WANTS: 'nope', MAX_PACK_BYTES: '-5' };
    expect(ConfigurationManager.repo.getMaxFetchWants(env)).toBe(64);
    expect(ConfigurationManager.repo.getMaxPackBytes(env)).toBe(52_428_800);
  });
});

describe('validateFetchRequestCounts', () => {
  const limits = { maxWants: 2, maxHaves: 2 };

  it('accepts a normal request', () => {
    const req = parseFetchRequest(new Uint8Array(), ['want abc', 'have def', 'done']);
    expect(validateFetchRequestCounts(req, limits)).toBeNull();
  });

  it('rejects too many wants and haves', () => {
    const manyWants = parseFetchRequest(new Uint8Array(), ['want a', 'want b', 'want c']);
    expect(validateFetchRequestCounts(manyWants, limits)).toContain('too many wants');
    const manyHaves = parseFetchRequest(new Uint8Array(), ['want a', 'have 1', 'have 2', 'have 3']);
    expect(validateFetchRequestCounts(manyHaves, limits)).toContain('too many haves');
  });

  it('rejects invalid deepen values', () => {
    for (const arg of ['deepen 0', 'deepen -3', 'deepen 1000001']) {
      const req = parseFetchRequest(new Uint8Array(), ['want a', arg]);
      expect(validateFetchRequestCounts(req, limits)).toContain('invalid deepen');
    }
  });

  it('rejects invalid deepen-since values', () => {
    const negative = parseFetchRequest(new Uint8Array(), ['want a', 'deepen-since -1']);
    expect(validateFetchRequestCounts(negative, limits)).toContain('invalid deepen-since');
    const future = parseFetchRequest(new Uint8Array(), ['want a', `deepen-since ${Math.trunc(Date.now() / 1000) + 100_000}`]);
    expect(validateFetchRequestCounts(future, limits)).toContain('in the future');
  });

  it('rejects too many deepen-not entries', () => {
    const req = parseFetchRequest(new Uint8Array(), ['want a', 'deepen-not r1', 'deepen-not r2', 'deepen-not r3']);
    expect(validateFetchRequestCounts(req, limits)).toContain('too many deepen-not');
  });
});

describe('validateReceivePackCounts', () => {
  const limits = { maxCommands: 1, maxPackBytes: 10 };

  it('accepts a normal push', () => {
    expect(validateReceivePackCounts(1, 10, limits)).toBeNull();
  });

  it('rejects too many ref updates and oversized packs', () => {
    expect(validateReceivePackCounts(2, 10, limits)).toContain('too many ref updates');
    expect(validateReceivePackCounts(1, 11, limits)).toContain('pack too large');
  });
});

describe('buildFetchErrorResponse', () => {
  it('returns ERR body with git result content type', async () => {
    const res = await buildFetchErrorResponse('too many wants', 400);
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toContain('git-upload-pack-result');
    expect(await res.text()).toContain('ERR too many wants');
  });
});

describe('GitService limits and cache', () => {
  it('exposes PackLimitError as an Error', () => {
    const error = new PackLimitError('boom');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PackLimitError');
  });

  it('rejects oversized haves without touching storage', async () => {
    const svc = new GitService({ promises: {} } as never, '/repo');
    const haves = Array.from({ length: 3 }, (_, i) => `${i}`.repeat(40));
    await expect(svc.findCommonCommits(haves, 2)).rejects.toBeInstanceOf(PackLimitError);
  });

  it('supports cache clear and TTL expiry without storage', () => {
    const svc = new GitService({ promises: {} } as never, '/repo');
    expect(() => svc.clearCache()).not.toThrow();
    expect(() => svc.ensureFreshCache(0)).not.toThrow();
    // Cache policy lives in the shared `GitCache` holder (extracted from the
    // former per-service `cacheCreatedAt` fields). Behavioral check: expiry
    // triggers a clear without throwing, even with no storage backend.
    const holder = (svc as unknown as { cacheHolder: { clearCache(): void; ensureFreshCache(ttl: number): void } }).cacheHolder;
    expect(holder).toBeDefined();
    expect(() => holder.ensureFreshCache(3600)).not.toThrow();
    expect(() => svc.ensureFreshCache(3600)).not.toThrow();
  });

  it('short-circuits empty pack collection within budget', async () => {
    const svc = new GitService({ promises: {} } as never, '/repo');
    await expect(svc.collectObjectsForPack([], [], { maxObjects: 10 })).resolves.toEqual({ oids: [], shallow: [] });
  });

  it('uses a deterministic oid fixture', () => {
    expect(OID).toHaveLength(40);
  });
});

describe('partial-clone filters with explicit wants', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeRepo(): Promise<{ gitdir: string; commitOid: string; treeOid: string; blobOid: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-filter-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.writeFile(path.join(dir, 'hello.txt'), 'hello partial\n');
    await git.add({ fs, dir, filepath: 'hello.txt' });
    const commitOid = await git.commit({
      fs,
      dir,
      author: { name: 'tester', email: 'tester@example.com' },
      message: 'init',
    });
    const commit = await git.readCommit({ fs, dir, oid: commitOid });
    const { oid: blobOid } = await git.readBlob({ fs, dir, oid: commitOid, filepath: 'hello.txt' });
    return { gitdir: path.join(dir, '.git'), commitOid, treeOid: commit.commit.tree, blobOid };
  }

  it('omits traversal-discovered blobs under blob:none', async () => {
    const { gitdir, commitOid, blobOid } = await makeRepo();
    const svc = new GitService(fs as never, gitdir);
    const { oids } = await svc.collectObjectsForPack([commitOid], [], { filter: 'blob:none' });
    expect(oids).toContain(commitOid);
    expect(oids).not.toContain(blobOid);
  });

  it('sends explicitly wanted blobs despite blob:none (promisor lazy-fetch)', async () => {
    const { gitdir, blobOid } = await makeRepo();
    const svc = new GitService(fs as never, gitdir);
    const { oids } = await svc.collectObjectsForPack([blobOid], [], { filter: 'blob:none' });
    expect(oids).toContain(blobOid);
  });

  it('sends explicitly wanted blobs despite blob:limit', async () => {
    const { gitdir, commitOid, blobOid } = await makeRepo();
    const svc = new GitService(fs as never, gitdir);
    const filtered = await svc.collectObjectsForPack([commitOid], [], { filter: 'blob:limit=1' });
    expect(filtered.oids).not.toContain(blobOid);
    const explicit = await svc.collectObjectsForPack([blobOid], [], { filter: 'blob:limit=1' });
    expect(explicit.oids).toContain(blobOid);
  });

  it('sends explicitly wanted trees despite tree:0', async () => {
    const { gitdir, commitOid, treeOid } = await makeRepo();
    const svc = new GitService(fs as never, gitdir);
    const filtered = await svc.collectObjectsForPack([commitOid], [], { filter: 'tree:0' });
    expect(filtered.oids).toContain(commitOid);
    expect(filtered.oids).not.toContain(treeOid);
    const explicit = await svc.collectObjectsForPack([treeOid], [], { filter: 'tree:0' });
    expect(explicit.oids).toContain(treeOid);
  });
});
