import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { afterEach, describe, expect, it, vi } from 'vitest';
// NOTE: relative imports bypass packages/git-service/src/index.ts, which
// re-exports the `dofs` runtime (unparsable in the node unit pool).
import { GitService, PackLimitError } from '../packages/git-service/src/GitService';
import { IsoGitFs } from '../packages/git-service/src/IsoGitFs';
import { HistoryService } from '../packages/git-service/src/HistoryService';
import { PackCollector } from '../packages/git-service/src/PackCollector';
import { ObjectReader } from '../packages/git-service/src/ObjectReader';
import { MergeService, isValidBranchName } from '../packages/git-service/src/MergeService';
import { splitFilePath } from '../packages/git-service/src/WriteService';

const AUTHOR = { name: 'tester', email: 'tester@example.com' };

/** Legacy redirect shim: `applyRefUpdates` used to hardcode `/repo`; it now honors `this.gitdir`. Kept so older branches calling with `/repo` still resolve onto tmp. */
function redirectClient(tmpGitdir: string): { promises: unknown } {
  const target = fs.promises as unknown as Record<string, unknown>;
  const promises = new Proxy(target, {
    get: (t, prop: string) => {
      const orig = t[prop];
      if (typeof orig !== 'function') return orig;
      return (p: unknown, ...rest: unknown[]) => {
        const redirected = typeof p === 'string' && (p === '/repo' || p.startsWith('/repo/')) ? `${tmpGitdir}${p.slice(5)}` : p;
        return (orig as (...a: unknown[]) => unknown).call(t, redirected, ...rest);
      };
    },
  });
  return { promises };
}

function fakeDofs(overrides: Record<string, unknown> = {}) {
  return {
    read: (p: string) => {
      if (p === '/missing') throw new Error('ENOENT');
      return new TextEncoder().encode(`content:${p}`);
    },
    writeFile: () => undefined,
    unlink: (p: string) => {
      if (p === '/missing') throw new Error('ENOENT');
    },
    listDir: (p: string) => {
      if (p === '/empty') return [] as string[];
      return ['.', '..', 'a.txt'];
    },
    mkdir: () => undefined,
    rmdir: () => undefined,
    stat: (p: string) => {
      if (p === '/missing') throw new Error('ENOENT');
      return { isFile: true, isDirectory: false, size: 5, mode: 0o100644 } as never;
    },
    readlink: (p: string) => {
      if (p === '/link') return '/target';
      throw new Error('ENOENT');
    },
    symlink: () => undefined,
    ...overrides,
  } as never;
}

describe('GitService hardening: initRepo and empty refs', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('initRepo creates a bare repo; listRefs on it is empty', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-init-'));
    tmpDirs.push(dir);
    const bareAt = path.join(dir, 'bare.git');
    const svc = new GitService(fs as never, bareAt);
    await svc.initRepo();
    const head = await fs.promises.readFile(path.join(bareAt, 'HEAD'), 'utf8');
    expect(head).toContain('refs/heads/main');
    // listRefs honors the injected gitdir (no hardcoded /repo/HEAD read).
    const empty = await svc.listRefs();
    expect(empty.refs).toEqual([]);
    expect(empty.symbolicHead).toBe('refs/heads/main');
    // With redirect the symbolic head resolves (legacy compat path).
    const redirected = new GitService(redirectClient(bareAt) as never, '/repo');
    const listed = await redirected.listRefs();
    expect(listed.symbolicHead).toBe('refs/heads/main');
    expect(listed.refs).toEqual([]);
  });

  it('resolveRef returns null for missing refs and hasObject is false on empty repo', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-empty-'));
    tmpDirs.push(dir);
    const bareAt = path.join(dir, 'bare.git');
    const svc = new GitService(fs as never, bareAt);
    await svc.initRepo();
    expect(await svc.resolveRef('refs/heads/nope')).toBeNull();
    expect(await svc.resolveRef()).toBeNull();
    expect(await svc.hasObject('d'.repeat(40))).toBe(false);
    expect(await svc.readObject('d'.repeat(40))).toBeNull();
    expect(await svc.readObjectForLsRefs('d'.repeat(40))).toBeNull();
    expect(await svc.expandRef('refs/heads/nope')).toBeNull();
    expect(await svc.peelTag('d'.repeat(40))).toBeNull();
  });
});

describe('GitService hardening: branches, tags, current', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeSvc(): Promise<{ svc: GitService; dir: string; gitdir: string; c1: string; c2: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-br-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'v1');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const c1 = await git.commit({ fs, dir, author: AUTHOR, message: 'c1' });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'v2');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const c2 = await git.commit({ fs, dir, author: AUTHOR, message: 'c2' });
    const gitdir = path.join(dir, '.git');
    return { svc: new GitService(fs as never, gitdir), dir, gitdir, c1, c2 };
  }

  it('createBranch validates names and start points', async () => {
    const { svc, c1 } = await makeSvc();
    await expect(svc.createBranch('', c1)).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(svc.createBranch('has space', c1)).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(svc.createBranch('ok-name', 'short')).resolves.toEqual({ ok: false, error: 'unknown start point', status: 404 });
    await expect(svc.createBranch('ok-name', 'd'.repeat(40))).resolves.toEqual({
      ok: false,
      error: 'unknown start point',
      status: 404,
    });
  });

  it('createBranch succeeds, rejects duplicates, deleteBranchRef protects current', async () => {
    const { svc, c1 } = await makeSvc();
    await expect(svc.createBranch('feat', c1)).resolves.toMatchObject({ ok: true, ref: 'refs/heads/feat' });
    await expect(svc.createBranch('feat', c1)).resolves.toEqual({ ok: false, error: 'branch already exists', status: 409 });
    await expect(svc.deleteBranchRef('has space')).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(svc.deleteBranchRef('ghost')).resolves.toEqual({ ok: false, error: 'branch not found', status: 404 });
    await expect(svc.deleteBranchRef('master')).resolves.toEqual({
      ok: false,
      error: 'cannot delete the default branch',
      status: 409,
    });
    await expect(svc.deleteBranchRef('feat')).resolves.toEqual({ ok: true, ref: 'refs/heads/feat' });
    expect(await svc.listBranches()).not.toContain('feat');
  });

  it('lists branches with oids, tags, and current branch', async () => {
    const { svc, dir, c1, c2 } = await makeSvc();
    await git.branch({ fs, dir, ref: 'side', object: c1, checkout: false });
    await git.annotatedTag({ fs, dir, ref: 'v1', object: c2, message: 'r', tagger: AUTHOR });
    expect(await svc.listBranches()).toContain('side');
    const withOid = await svc.listBranchesWithOid();
    expect(withOid.find((b) => b.ref === 'refs/heads/side')?.oid).toBe(c1);
    const tags = await svc.listTags();
    expect(tags.some((t) => t.ref === 'refs/tags/v1')).toBe(true);
    expect(await svc.currentBranch()).toBe('master');
    await expect(svc.setDefaultBranch('has space')).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(svc.setDefaultBranch('ghost')).resolves.toEqual({ ok: false, error: 'branch not found', status: 404 });
    await expect(svc.setDefaultBranch('side')).resolves.toEqual({ ok: true, defaultBranch: 'side' });
  });

  it('merger deleteBranch validates and deletes', async () => {
    const { svc, c1 } = await makeSvc();
    await expect(svc.deleteBranch('has space')).rejects.toThrow('invalid branch name');
    await svc.createBranch('todel', c1);
    await expect(svc.deleteBranch('todel')).resolves.toBeUndefined();
    expect(await svc.listBranches()).not.toContain('todel');
  });

  it('isValidBranchName guards edge inputs', () => {
    expect(isValidBranchName('')).toBe(false);
    expect(isValidBranchName('a'.repeat(256))).toBe(false);
    expect(isValidBranchName('/lead')).toBe(false);
    expect(isValidBranchName('trail/')).toBe(false);
    expect(isValidBranchName('a//b')).toBe(false);
    expect(isValidBranchName('ok/name-1.x')).toBe(true);
  });
});

describe('GitService hardening: cache controls and TTL', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  async function makeSvc(): Promise<GitService> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-cache-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'v1');
    await git.add({ fs, dir, filepath: 'f.txt' });
    await git.commit({ fs, dir, author: AUTHOR, message: 'c1' });
    return new GitService(fs as never, path.join(dir, '.git'));
  }

  it('clearCache and fresh TTL are no-ops without expiry', async () => {
    const svc = await makeSvc();
    expect(() => svc.clearCache()).not.toThrow();
    expect(() => svc.ensureFreshCache(3600)).not.toThrow();
    expect(() => svc.ensureFreshCache(0)).not.toThrow();
    expect(() => svc.ensureFreshCache(-1)).not.toThrow();
    expect(() => svc.ensureFreshCache(Number.NaN)).not.toThrow();
    expect(() => svc.ensureFreshCache(Number.POSITIVE_INFINITY)).not.toThrow();
  });

  it('ensureFreshCache rotates sub-caches after TTL expiry', async () => {
    const svc = await makeSvc();
    // Prime caches with a read.
    await svc.hasObject('d'.repeat(40));
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 7200 * 1000);
    expect(() => svc.ensureFreshCache(3600)).not.toThrow();
    vi.restoreAllMocks();
    expect(() => svc.ensureFreshCache(3600)).not.toThrow();
  });

  it('HistoryService/PackCollector/ObjectReader TTL paths clear and ignore bad TTLs', async () => {
    const hrs = new HistoryService({} as never, '/repo');
    hrs.ensureFreshCache(0);
    hrs.ensureFreshCache(Number.NaN);
    hrs.ensureFreshCache(3600);
    hrs.clearCache();
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 7200 * 1000);
    hrs.ensureFreshCache(1);
    vi.restoreAllMocks();

    const pack = new PackCollector({} as never, '/repo');
    pack.ensureFreshCache(0);
    pack.clearCache();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7200 * 1000);
    pack.ensureFreshCache(1);
    vi.restoreAllMocks();

    const reader = new ObjectReader({} as never, '/repo');
    reader.ensureFreshCache(0);
    reader.clearCache();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7200 * 1000);
    reader.ensureFreshCache(1);
    vi.restoreAllMocks();

    const merger = new MergeService({} as never, '/repo');
    expect(() => merger.clearCache()).not.toThrow();
    expect(await merger.resolveRef('refs/heads/nope')).toBeNull();
  });
});

describe('GitService hardening: packs', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeLinear(commits = 3): Promise<{ svc: GitService; dir: string; gitdir: string; oids: string[] }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-pack-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    const oids: string[] = [];
    for (let i = 0; i < commits; i++) {
      await fs.promises.writeFile(path.join(dir, 'f.txt'), `rev ${i}\n`);
      await git.add({ fs, dir, filepath: 'f.txt' });
      oids.push(await git.commit({ fs, dir, author: AUTHOR, message: `rev ${i}` }));
    }
    return { svc: new GitService(fs as never, path.join(dir, '.git')), dir, gitdir: path.join(dir, '.git'), oids };
  }

  it('packObjects handles empty and single oid lists', async () => {
    const { svc, oids } = await makeLinear(2);
    const empty = (await svc.packObjects([])) as unknown as Uint8Array;
    expect(empty).toBeInstanceOf(Uint8Array);
    expect(empty.length).toBeGreaterThan(0);
    const single = (await svc.packObjects([oids[1]])) as unknown as Uint8Array;
    expect(single).toBeInstanceOf(Uint8Array);
    expect(single.length).toBeGreaterThan(empty.length);
  });

  it('collectObjectsForPack enforces maxObjects and handles empty wants', async () => {
    const { svc, oids } = await makeLinear(3);
    await expect(svc.collectObjectsForPack([oids[2]], [], { maxObjects: 0 })).rejects.toBeInstanceOf(PackLimitError);
    await expect(svc.collectObjectsForPack([oids[2]], [], { maxObjects: 0 })).rejects.toThrow('too many objects');
    await expect(svc.collectObjectsForPack([], [], { maxObjects: 10 })).resolves.toEqual({ oids: [], shallow: [] });
  });

  it('collectObjectsForPack supports depth, since, exclude, and haves', async () => {
    const { svc, oids } = await makeLinear(4);
    const depth = await svc.collectObjectsForPack([oids[3]], [], { depth: 1 });
    expect(depth.shallow).toEqual([oids[3]]);
    expect(depth.oids).toContain(oids[3]);
    const future = Math.trunc(Date.now() / 1000) + 10_000;
    const since = await svc.collectObjectsForPack([oids[2]], [], { since: future });
    expect(since.oids).toEqual([oids[2]]);
    expect(since.shallow).toEqual([oids[2]]);
    const excluded = await svc.collectObjectsForPack([oids[2]], [], { exclude: [oids[2]] });
    expect(excluded).toEqual({ oids: [], shallow: [] });
    // Haves prune but empty result when want is already held.
    const held = await svc.collectObjectsForPack([oids[2]], [oids[2]]);
    expect(held.oids).toEqual([]);
  });

  it('collectObjectsForPack honors blob/tree filters', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-filter-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    const content = '0123456789abcdef';
    await fs.promises.writeFile(path.join(dir, 'f.txt'), content);
    await git.add({ fs, dir, filepath: 'f.txt' });
    const commitOid = await git.commit({ fs, dir, author: AUTHOR, message: 'm' });
    const svc = new GitService(fs as never, path.join(dir, '.git'));
    const { oid: blobOid } = await git.readBlob({ fs, dir, oid: commitOid, filepath: 'f.txt' });
    const kept = await svc.collectObjectsForPack([commitOid], [], { filter: `blob:limit=${content.length}` });
    expect(kept.oids).toContain(blobOid);
    const skipped = await svc.collectObjectsForPack([commitOid], [], { filter: `blob:limit=${content.length - 1}` });
    expect(skipped.oids).not.toContain(blobOid);
    expect(skipped.oids).toContain(commitOid);
    const blobNone = await svc.collectObjectsForPack([commitOid], []);
    expect(blobNone.oids).toContain(blobOid);
    const filtered = await svc.collectObjectsForPack([commitOid], [], { filter: 'blob:none' });
    expect(filtered.oids).toContain(commitOid);
    const treeZero = await svc.collectObjectsForPack([commitOid], [], { filter: 'tree:0' });
    expect(treeZero.oids).toContain(commitOid);
  });

  it('collectObjectsForPack handles deepen-relative reachable and unreachable', async () => {
    const { svc, oids } = await makeLinear(5);
    const relative = await svc.collectObjectsForPack([oids[4]], [], { depth: 2, deepenRelative: true, relativeTo: [oids[3]] });
    expect(relative.shallow).toEqual([oids[1]]);
    expect(relative.oids).toContain(oids[3]);
    expect(relative.oids).not.toContain(oids[0]);
    const unreachable = await svc.collectObjectsForPack([oids[4]], [], {
      depth: 1,
      deepenRelative: true,
      relativeTo: ['d'.repeat(40)],
    });
    expect(unreachable.shallow).toEqual([oids[4]]);
  });

  it('collectObjectsForPack expands annotated tags', async () => {
    const { svc, dir, oids } = await makeLinear(2);
    await git.annotatedTag({ fs, dir, ref: 'vtag', object: oids[1], message: 'rel', tagger: AUTHOR });
    const tagOid = await git.resolveRef({ fs, dir, ref: 'refs/tags/vtag' });
    expect(tagOid).not.toBe(oids[1]);
    const collected = await svc.collectObjectsForPack([tagOid], []);
    expect(collected.oids).toContain(tagOid);
    expect(collected.oids).toContain(oids[1]);
  });

  it('hasObject and findCommonCommits cover present, missing, and limits', async () => {
    const { svc, oids } = await makeLinear(2);
    expect(await svc.hasObject(oids[1])).toBe(true);
    expect(await svc.hasObject('d'.repeat(40))).toBe(false);
    expect(await svc.findCommonCommits([oids[1], 'd'.repeat(40)])).toEqual([oids[1]]);
    expect(await svc.findCommonCommits([])).toEqual([]);
    await expect(svc.findCommonCommits([oids[0], oids[1]], 1)).rejects.toBeInstanceOf(PackLimitError);
    await expect(svc.findCommonCommits([oids[0], oids[1]], 1)).rejects.toThrow('too many haves');
  });

  it('indexPack succeeds for a real pack and fails for a missing file', async () => {
    const { svc, gitdir, oids } = await makeLinear(2);
    const pack = (await svc.packObjects([oids[1]])) as unknown as Uint8Array;
    const rel = 'objects/pack/hardening.pack';
    await fs.promises.writeFile(path.join(gitdir, rel), Buffer.from(pack));
    await expect(svc.indexPack(rel)).resolves.toBeUndefined();
    await expect(svc.indexPack('objects/pack/does-not-exist.pack')).rejects.toThrow();
  });
});

describe('GitService hardening: history reads', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeSvc(): Promise<{ svc: GitService; dir: string; gitdir: string; c1: string; c2: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-hist-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'v1');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const c1 = await git.commit({ fs, dir, author: AUTHOR, message: 'c1' });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'v2');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const c2 = await git.commit({ fs, dir, author: AUTHOR, message: 'c2' });
    return { svc: new GitService(fs as never, path.join(dir, '.git')), dir, gitdir: path.join(dir, '.git'), c1, c2 };
  }

  it('getLastCommit and getLog handle missing refs', async () => {
    const { svc, c2 } = await makeSvc();
    expect((await svc.getLastCommit('master'))?.oid).toBe(c2);
    expect(await svc.getLastCommit('ghost')).toBeUndefined();
    expect(await svc.getLog({ ref: 'master', depth: 1 })).toHaveLength(1);
    expect(await svc.getLog({ ref: 'ghost', depth: 1 })).toEqual([]);
  });

  it('getTree/getBlob cover nested, missing, and binary paths', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-tree-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.mkdir(path.join(dir, 'a', 'b'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'a', 'b', 'c.txt'), 'deep');
    await fs.promises.writeFile(path.join(dir, 'bin.dat'), Buffer.from([104, 105, 0, 1]));
    await git.add({ fs, dir, filepath: 'a/b/c.txt' });
    await git.add({ fs, dir, filepath: 'bin.dat' });
    const oid = await git.commit({ fs, dir, author: AUTHOR, message: 'm' });
    const svc = new GitService(fs as never, path.join(dir, '.git'));
    const root = (await svc.getTree(oid)) as Array<{ path: string }>;
    expect(root.map((e) => e.path).sort()).toContain('a');
    expect(await svc.getTree(oid, 'nope')).toEqual([]);
    expect(await svc.getTree('d'.repeat(40), '')).toEqual([]);
    const blob = await svc.getBlob(oid, 'a/b/c.txt');
    expect(new TextDecoder().decode(blob?.content as Uint8Array)).toBe('deep');
    expect(await svc.getBlob(oid, 'missing.txt')).toBeNull();
    const bin = await svc.getBlob(oid, 'bin.dat');
    expect(bin?.isBinary).toBe(true);
    expect(svc.getBlobSize(new Uint8Array([1, 2, 3]))).toBe(3);
    expect(svc.detectBinary(new Uint8Array([1, 0]))).toBe(true);
    expect(svc.detectBinary(new Uint8Array([104, 105]))).toBe(false);
  });

  it('getCommit covers root, chained, and missing commits', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-commit-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'only');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const root = await git.commit({ fs, dir, author: AUTHOR, message: 'root' });
    const svc = new GitService(fs as never, path.join(dir, '.git'));
    const rootView = await svc.getCommit(root);
    expect(rootView.commit).toBeDefined();
    expect(Array.isArray(rootView.changes)).toBe(true);
    expect((await svc.getCommit('d'.repeat(40))).commit).toBeNull();
  });

  it('getFileStateChanges, getCommitDiff, getCompareDiff edges', async () => {
    const { svc, c1, c2 } = await makeSvc();
    expect(await svc.getFileStateChanges(c1, c2)).toHaveLength(1);
    expect(await svc.getFileStateChanges(c2, c2)).toEqual([]);
    const diff = await svc.getCommitDiff(c2, 10);
    expect(diff.commit).toBeDefined();
    expect(diff.truncated).toBe(false);
    expect(diff.files.length).toBeGreaterThan(0);
    const missing = await svc.getCommitDiff('d'.repeat(40), 10);
    expect(missing.commit).toBeNull();
    expect(await svc.getCompareDiff('ghost', 'master', 10)).toBeNull();
    expect(await svc.getCompareDiff('master', 'ghost', 10)).toBeNull();
    const cmp = await svc.getCompareDiff('master', 'master', 10);
    expect(cmp?.baseOid).toBe(c2);
    expect(cmp?.mergeBase).toBe(c2);
    const truncated = await svc.getCommitDiff(c2, 0);
    expect(truncated.truncated).toBe(true);
    expect(truncated.files).toEqual([]);
  });

  it('getBlame covers ok, missing ref/file, binary, and truncation caps', async () => {
    const { svc } = await makeSvc();
    const blame = await svc.getBlame('master', 'f.txt');
    expect(blame?.lines.length).toBeGreaterThan(0);
    expect(await svc.getBlame('ghost', 'f.txt')).toBeNull();
    expect(await svc.getBlame('master', 'ghost.txt')).toBeNull();

    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-blame-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.writeFile(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2]));
    await git.add({ fs, dir, filepath: 'bin.dat' });
    await fs.promises.writeFile(path.join(dir, 'many.txt'), `${'x\n'.repeat(6000)}`);
    await git.add({ fs, dir, filepath: 'many.txt' });
    await fs.promises.writeFile(path.join(dir, 'huge.txt'), 'a'.repeat(200001));
    await git.add({ fs, dir, filepath: 'huge.txt' });
    await git.commit({ fs, dir, author: AUTHOR, message: 'm' });
    const svc2 = new GitService(fs as never, path.join(dir, '.git'));
    expect(await svc2.getBlame('master', 'bin.dat')).toBeNull();
    const many = await svc2.getBlame('master', 'many.txt');
    expect(many?.truncated).toBe(true);
    const huge = await svc2.getBlame('master', 'huge.txt');
    expect(huge?.truncated).toBe(true);
  });

  it('readObject, expandRef, peelTag delegate with null on missing', async () => {
    const { svc, dir, c2 } = await makeSvc();
    expect((await svc.readObject(c2))?.type).toBe('commit');
    expect(await svc.readObject('d'.repeat(40))).toBeNull();
    expect((await svc.readObjectForLsRefs(c2))?.type).toBe('commit');
    expect(await svc.expandRef('refs/heads/master')).toBe('refs/heads/master');
    expect(await svc.expandRef('refs/heads/ghost')).toBeNull();
    await git.annotatedTag({ fs, dir, ref: 'v1', object: c2, message: 'r', tagger: AUTHOR });
    const tagOid = await git.resolveRef({ fs, dir, ref: 'refs/tags/v1' });
    expect(await svc.peelTag(tagOid)).toBe(c2);
    expect(await svc.peelTag('d'.repeat(40))).toBeNull();
  });
});

describe('GitService hardening: merge preview and operations', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makePair(): Promise<{ svc: GitService; dir: string; c1: string; c2: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-merge-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'v1');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const c1 = await git.commit({ fs, dir, author: AUTHOR, message: 'c1' });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'v2');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const c2 = await git.commit({ fs, dir, author: AUTHOR, message: 'c2' });
    return { svc: new GitService(fs as never, path.join(dir, '.git')), dir, c1, c2 };
  }

  it('findMergeBase and isAncestor handle invalid oids', async () => {
    const { svc, c1, c2 } = await makePair();
    expect(await svc.findMergeBase([c1, c2])).toBe(c1);
    expect(await svc.findMergeBase(['a'.repeat(40), 'b'.repeat(40)])).toBeNull();
    expect(await svc.isAncestor(c1, c2)).toBe(true);
    expect(await svc.isAncestor(c2, c1)).toBe(false);
    expect(await svc.isAncestor('x'.repeat(40), 'y'.repeat(40))).toBe(false);
    expect(await svc.isAncestor('nothex', 'also-not')).toBe(false);
  });

  it('getMergePreview and getMergePreviewByOids edges', async () => {
    const { svc, c1, c2 } = await makePair();
    expect(await svc.getMergePreview('ghost', 'master')).toBeNull();
    expect(await svc.getMergePreview('master', 'ghost')).toBeNull();
    const same = await svc.getMergePreview('master', 'master');
    expect(same?.alreadyMerged).toBe(true);
    expect(await svc.getMergePreviewByOids('bad', 'also-bad')).toBeNull();
    expect(await svc.getMergePreviewByOids(c1, c1)).toMatchObject({ alreadyMerged: true, canFastForward: true });
    const preview = await svc.getMergePreviewByOids(c1, c2);
    expect(preview?.canFastForward).toBe(true);
  });

  it('mergeBranches validates inputs and handles already-merged', async () => {
    const { svc, c2 } = await makePair();
    await expect(svc.mergeBranches({ baseBranch: 'has space', headOid: c2, author: AUTHOR })).rejects.toThrow('invalid base branch');
    await expect(svc.mergeBranches({ baseBranch: 'master', headOid: 'bad', author: AUTHOR })).rejects.toThrow('invalid head oid');
    await expect(svc.mergeBranches({ baseBranch: 'ghost', headOid: c2, author: AUTHOR })).rejects.toThrow('base branch not found');
    await expect(svc.mergeBranches({ baseBranch: 'master', headOid: c2, author: AUTHOR })).resolves.toMatchObject({
      type: 'already-merged',
    });
  });

  it('mergeBranches fast-forwards, commits, and reports conflicts', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-mops-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'base');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const b1 = await git.commit({ fs, dir, author: AUTHOR, message: 'b1' });
    await git.branch({ fs, dir, ref: 'feat', object: b1, checkout: false });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'master2');
    await git.add({ fs, dir, filepath: 'f.txt' });
    await git.commit({ fs, dir, author: AUTHOR, message: 'b2' });
    await git.checkout({ fs, dir, ref: 'feat' });
    await fs.promises.writeFile(path.join(dir, 'g.txt'), 'feat');
    await git.add({ fs, dir, filepath: 'g.txt' });
    const featHead = await git.commit({ fs, dir, author: AUTHOR, message: 'feat' });
    await git.checkout({ fs, dir, ref: 'master' });
    const svc = new GitService(fs as never, path.join(dir, '.git'));
    const merged = await svc.mergeBranches({ baseBranch: 'master', headOid: featHead, author: AUTHOR });
    expect(merged.type).toBe('merge-commit');

    // Fast-forward: old branch behind tip merges tip.
    const tip = await svc.resolveRef('refs/heads/master');
    await svc.createBranch('old', b1);
    const ff = await svc.mergeBranches({ baseBranch: 'old', headOid: tip as string, author: AUTHOR });
    expect(ff.type).toBe('fast-forward');

    // Conflict: same file diverged on both sides.
    const dir2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-conf-'));
    tmpDirs.push(dir2);
    await git.init({ fs, dir: dir2 });
    await fs.promises.writeFile(path.join(dir2, 'f.txt'), 'base');
    await git.add({ fs, dir: dir2, filepath: 'f.txt' });
    const x1 = await git.commit({ fs, dir: dir2, author: AUTHOR, message: 'x1' });
    await git.branch({ fs, dir: dir2, ref: 'feat', object: x1, checkout: false });
    await fs.promises.writeFile(path.join(dir2, 'f.txt'), 'master-change');
    await git.add({ fs, dir: dir2, filepath: 'f.txt' });
    await git.commit({ fs, dir: dir2, author: AUTHOR, message: 'x2' });
    await git.checkout({ fs, dir: dir2, ref: 'feat' });
    await fs.promises.writeFile(path.join(dir2, 'f.txt'), 'feat-change');
    await git.add({ fs, dir: dir2, filepath: 'f.txt' });
    const x3 = await git.commit({ fs, dir: dir2, author: AUTHOR, message: 'x3' });
    await git.checkout({ fs, dir: dir2, ref: 'master' });
    const svc2 = new GitService(fs as never, path.join(dir2, '.git'));
    const conflict = await svc2.mergeBranches({ baseBranch: 'master', headOid: x3, author: AUTHOR });
    expect(conflict.type).toBe('conflict');
  });

  it('squashMerge and rebaseMerge validate and handle heads', async () => {
    const { svc, c1, c2 } = await makePair();
    await expect(svc.squashMerge({ baseBranch: 'has space', headOid: c2, author: AUTHOR })).rejects.toThrow('invalid base branch');
    await expect(svc.squashMerge({ baseBranch: 'master', headOid: 'bad', author: AUTHOR })).rejects.toThrow('invalid head oid');
    await expect(svc.squashMerge({ baseBranch: 'ghost', headOid: c2, author: AUTHOR })).rejects.toThrow('base branch not found');
    await expect(svc.squashMerge({ baseBranch: 'master', headOid: c2, author: AUTHOR })).resolves.toMatchObject({
      type: 'already-merged',
    });
    await expect(svc.squashMerge({ baseBranch: 'master', headOid: 'a'.repeat(40), author: AUTHOR })).rejects.toThrow(
      'head commit not found',
    );
    // Squash with a real diverged head succeeds.
    await svc.createBranch('sq', c1);
    const sq = await svc.squashMerge({ baseBranch: 'sq', headOid: c2, author: AUTHOR, message: 'sq it' });
    expect(sq.type).toBe('fast-forward');

    await expect(svc.rebaseMerge({ baseBranch: 'has space', headOid: c2, author: AUTHOR })).rejects.toThrow('invalid base branch');
    await expect(svc.rebaseMerge({ baseBranch: 'master', headOid: 'bad', author: AUTHOR })).rejects.toThrow('invalid head oid');
    await expect(svc.rebaseMerge({ baseBranch: 'ghost', headOid: c2, author: AUTHOR })).rejects.toThrow('base branch not found');
    const missing = await svc.rebaseMerge({ baseBranch: 'master', headOid: 'a'.repeat(40), author: AUTHOR });
    expect(missing.type).toBe('conflict');
  });

  it('rebaseMerge replays a single diverged commit and rejects multi-commit heads', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-rebase-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'v1');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const r1 = await git.commit({ fs, dir, author: AUTHOR, message: 'r1' });
    await git.branch({ fs, dir, ref: 'feat', object: r1, checkout: false });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'v2-master');
    await git.add({ fs, dir, filepath: 'f.txt' });
    await git.commit({ fs, dir, author: AUTHOR, message: 'r2' });
    await git.checkout({ fs, dir, ref: 'feat' });
    await fs.promises.writeFile(path.join(dir, 'g.txt'), 'only');
    await git.add({ fs, dir, filepath: 'g.txt' });
    const r3 = await git.commit({ fs, dir, author: AUTHOR, message: 'r3' });
    await git.checkout({ fs, dir, ref: 'master' });
    const svc = new GitService(fs as never, path.join(dir, '.git'));
    const replayed = await svc.rebaseMerge({ baseBranch: 'master', headOid: r3, author: AUTHOR });
    expect(replayed.type).toBe('fast-forward');
    // Second commit on the side branch makes the head non-linear.
    await git.checkout({ fs, dir, ref: 'feat' });
    await fs.promises.writeFile(path.join(dir, 'h.txt'), 'second');
    await git.add({ fs, dir, filepath: 'h.txt' });
    const r4 = await git.commit({ fs, dir, author: AUTHOR, message: 'r4' });
    await git.checkout({ fs, dir, ref: 'master' });
    const multi = await svc.rebaseMerge({ baseBranch: 'master', headOid: r4, author: AUTHOR });
    expect(multi.type).toBe('conflict');
  });

  it('MergeService removeWorkdir tolerates missing rm/rmdir', async () => {
    const withoutRm = new MergeService({ promises: { rmdir: async () => undefined } } as never, '/repo');
    await expect((withoutRm as unknown as { removeWorkdir(w: string): Promise<void> }).removeWorkdir('/tmp-nope')).resolves.toBeUndefined();
    const failing = new MergeService(
      {
        promises: {
          rm: async () => {
            throw new Error('boom');
          },
          rmdir: async () => {
            throw new Error('boom');
          },
        },
      } as never,
      '/repo',
    );
    await expect((failing as unknown as { removeWorkdir(w: string): Promise<void> }).removeWorkdir('/tmp-nope')).resolves.toBeUndefined();
  });
});

describe('GitService hardening: commitFile caps', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeSvc(): Promise<{ svc: GitService; c1: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-write-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'v1');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const c1 = await git.commit({ fs, dir, author: AUTHOR, message: 'c1' });
    return { svc: new GitService(fs as never, path.join(dir, '.git')), c1 };
  }

  it('splitFilePath rejects unsafe paths', () => {
    expect(splitFilePath('')).toMatchObject({ ok: false });
    expect(splitFilePath('../evil')).toMatchObject({ ok: false });
    expect(splitFilePath('/abs')).toMatchObject({ ok: false });
    expect(splitFilePath('a//b')).toMatchObject({ ok: false });
    expect(splitFilePath('a/.git/b')).toMatchObject({ ok: false });
    expect(splitFilePath('ok/file.txt')).toMatchObject({ ok: true });
  });

  it('commitFile validates branch, message, author, size, and binary', async () => {
    const { svc } = await makeSvc();
    await expect(
      svc.commitFile({ branch: 'has space', path: 'a.txt', content: new TextEncoder().encode('x'), message: 'm', author: AUTHOR }),
    ).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(
      svc.commitFile({ branch: 'master', path: '../evil', content: new TextEncoder().encode('x'), message: 'm', author: AUTHOR }),
    ).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(
      svc.commitFile({ branch: 'master', path: 'a.txt', content: new TextEncoder().encode('x'), author: AUTHOR }),
    ).resolves.toMatchObject({ ok: false, error: 'message is required', status: 400 });
    await expect(
      svc.commitFile({
        branch: 'master',
        path: 'a.txt',
        content: new TextEncoder().encode('x'),
        message: 'm'.repeat(1001),
        author: AUTHOR,
      }),
    ).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(
      svc.commitFile({
        branch: 'master',
        path: 'a.txt',
        content: new TextEncoder().encode('x'),
        message: 'm',
        author: { name: '', email: 'bad' },
      }),
    ).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(
      svc.commitFile({
        branch: 'master',
        path: 'a.txt',
        content: new TextEncoder().encode('xx'),
        message: 'm',
        author: AUTHOR,
        maxFileBytes: 1,
      }),
    ).resolves.toMatchObject({ ok: false, status: 413 });
    await expect(
      svc.commitFile({
        branch: 'master',
        path: 'a.txt',
        content: new Uint8Array([104, 105, 0]),
        message: 'm',
        author: AUTHOR,
      }),
    ).resolves.toMatchObject({ ok: false, status: 400 });
  });

  it('commitFile enforces expectedOid, branch existence, and file existence', async () => {
    const { svc } = await makeSvc();
    await expect(
      svc.commitFile({
        branch: 'master',
        path: 'a.txt',
        content: new TextEncoder().encode('x'),
        message: 'm',
        author: AUTHOR,
        expectedOid: 'a'.repeat(40),
      }),
    ).resolves.toMatchObject({ ok: false, status: 409 });
    await expect(
      svc.commitFile({
        branch: 'ghost',
        path: 'a.txt',
        content: new TextEncoder().encode('x'),
        message: 'm',
        author: AUTHOR,
      }),
    ).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(
      svc.commitFile({ branch: 'master', path: 'ghost.txt', content: null, message: 'm', author: AUTHOR }),
    ).resolves.toMatchObject({ ok: false, status: 404 });
  });

  it('commitFile creates, no-ops on identical content, and deletes', async () => {
    const { svc } = await makeSvc();
    const created = await svc.commitFile({
      branch: 'master',
      path: 'new.txt',
      content: new TextEncoder().encode('hello'),
      message: 'add',
      author: AUTHOR,
    });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.created).toBe(true);
    const noop = await svc.commitFile({
      branch: 'master',
      path: 'new.txt',
      content: new TextEncoder().encode('hello'),
      message: 'add again',
      author: AUTHOR,
    });
    expect(noop).toMatchObject({ ok: true, created: false, deleted: false });
    const deleted = await svc.commitFile({
      branch: 'master',
      path: 'new.txt',
      content: null,
      message: 'del',
      author: AUTHOR,
    });
    expect(deleted).toMatchObject({ ok: true, deleted: true });
  });

  it('commitFile starts history on an unborn repo', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-unborn-'));
    tmpDirs.push(dir);
    const bareAt = path.join(dir, 'bare.git');
    const svc = new GitService(fs as never, bareAt);
    await svc.initRepo();
    const created = await svc.commitFile({
      branch: 'main',
      path: 'first.txt',
      content: new TextEncoder().encode('hello'),
      message: 'first',
      author: AUTHOR,
    });
    expect(created.ok).toBe(true);
    await expect(
      svc.commitFile({ branch: 'main', path: 'gone.txt', content: null, message: 'del', author: AUTHOR }),
    ).resolves.toMatchObject({ ok: false, status: 404 });
  });
});

describe('GitService hardening: applyRefUpdates', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeChain(): Promise<{ svc: GitService; gitdir: string; c1: string; c2: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-hard-apply-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'v1');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const c1 = await git.commit({ fs, dir, author: AUTHOR, message: 'c1' });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'v2');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const c2 = await git.commit({ fs, dir, author: AUTHOR, message: 'c2' });
    const gitdir = path.join(dir, '.git');
    // applyRefUpdates hardcodes gitdir `/repo`; redirect node fs there.
    const svc = new GitService(redirectClient(gitdir) as never, '/repo');
    await git.branch({ fs, dir, ref: 'feat', object: c1, checkout: false });
    return { svc, gitdir, c1, c2 };
  }

  it('fast-forwards matching updates and persists', async () => {
    const { svc, c1, c2 } = await makeChain();
    await expect(svc.applyRefUpdates([{ oldOid: c1, newOid: c2, ref: 'refs/heads/feat' }], false)).resolves.toEqual([
      { ref: 'refs/heads/feat', ok: true },
    ]);
    expect(await svc.resolveRef('refs/heads/feat')).toBe(c2);
  });

  it('rejects stale old OIDs and non-fast-forwards', async () => {
    const { svc, c1, c2 } = await makeChain();
    await expect(svc.applyRefUpdates([{ oldOid: c2, newOid: c2, ref: 'refs/heads/feat' }], false)).resolves.toEqual([
      { ref: 'refs/heads/feat', ok: false, error: 'ref update rejected: old OID mismatch' },
    ]);
    await expect(svc.applyRefUpdates([{ oldOid: c1, newOid: c1, ref: 'refs/heads/feat' }], false)).resolves.toEqual([
      { ref: 'refs/heads/feat', ok: false, error: 'non-fast-forward update rejected' },
    ]);
  });

  it('creates, reports existing/absent, deletes, and enforces atomicity', async () => {
    const { svc, c1 } = await makeChain();
    const zero = '0'.repeat(40);
    await expect(svc.applyRefUpdates([{ oldOid: zero, newOid: c1, ref: 'refs/heads/new' }], false)).resolves.toEqual([
      { ref: 'refs/heads/new', ok: true },
    ]);
    await expect(svc.applyRefUpdates([{ oldOid: zero, newOid: c1, ref: 'refs/heads/new' }], false)).resolves.toEqual([
      { ref: 'refs/heads/new', ok: false, error: 'ref already exists' },
    ]);
    await expect(svc.applyRefUpdates([{ oldOid: c1, newOid: zero, ref: 'refs/heads/ghost' }], false)).resolves.toEqual([
      { ref: 'refs/heads/ghost', ok: false, error: "ref doesn't exist" },
    ]);
    await expect(svc.applyRefUpdates([{ oldOid: c1, newOid: zero, ref: 'refs/heads/feat' }], false)).resolves.toEqual([
      { ref: 'refs/heads/feat', ok: true },
    ]);
    const { svc: svc2, c1: d1, c2: d2 } = await makeChain();
    const results = await svc2.applyRefUpdates(
      [
        { oldOid: d1, newOid: d2, ref: 'refs/heads/feat' },
        { oldOid: d1, newOid: d1, ref: 'refs/heads/ghost' },
      ],
      true,
    );
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(await svc2.resolveRef('refs/heads/feat')).toBe(d1);
  });
});

describe('IsoGitFs hardening: error and encoding paths', () => {
  it('readFile resolves string data without encoding as bytes and decodes with utf8', async () => {
    const dofs = fakeDofs({
      read: () => 'plain-string',
    });
    const client = new IsoGitFs(dofs).getPromiseFsClient().promises;
    const bytes = (await client.readFile('/s.txt')) as Uint8Array;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe('plain-string');
    expect(await client.readFile('/s.txt', 'utf8')).toBe('plain-string');
    expect(await client.readFile('/s.txt', { encoding: 'utf8' })).toBe('plain-string');
  });

  it('readFile surfaces errors with syscall and path', async () => {
    const client = new IsoGitFs(fakeDofs()).getPromiseFsClient().promises;
    await expect(client.readFile('/missing')).rejects.toMatchObject({ path: '/missing' });
  });

  it('writeFile supports string, ArrayBuffer, and view copies; errors annotate', async () => {
    let written: unknown;
    const dofs = fakeDofs({
      writeFile: (_p: string, data: unknown) => {
        written = data;
      },
    });
    const client = new IsoGitFs(dofs).getPromiseFsClient().promises;
    await client.writeFile('/a.txt', 'hello');
    expect(written).toBe('hello');
    const buf = new Uint8Array([1, 2, 3]).buffer;
    await client.writeFile('/b.bin', buf);
    expect(written).toBe(buf);
    const failing = new IsoGitFs(
      fakeDofs({
        writeFile: () => {
          throw new Error('ENOSPC');
        },
      }),
    ).getPromiseFsClient().promises;
    await expect(failing.writeFile('/x', 'y')).rejects.toMatchObject({ code: 'ENOSPC' });
  });

  it('unlink, readdir, mkdir, rmdir propagate annotated errors', async () => {
    const ok = new IsoGitFs(fakeDofs()).getPromiseFsClient().promises;
    await expect(ok.unlink('/a.txt')).resolves.toBeUndefined();
    await expect(ok.mkdir('/d')).resolves.toBeUndefined();
    await expect(ok.rmdir('/d')).resolves.toBeUndefined();
    await expect(ok.readdir('/')).resolves.toEqual(['a.txt']);

    const missing = new IsoGitFs(
      fakeDofs({
        listDir: (p: string) => {
          if (p === '/missing') throw new Error('ENOENT');
          return ['.', '..', 'a.txt'];
        },
      }),
    ).getPromiseFsClient().promises;
    await expect(missing.unlink('/missing')).rejects.toMatchObject({ path: '/missing' });
    await expect(missing.readdir('/missing' as string)).rejects.toMatchObject({ path: '/missing' });
    const failingStat = new IsoGitFs(
      fakeDofs({
        stat: () => {
          throw new Error('EACCES');
        },
      }),
    ).getPromiseFsClient().promises;
    await expect(failingStat.stat('/x')).rejects.toMatchObject({ code: 'EACCES' });
    const failingMk = new IsoGitFs(
      fakeDofs({
        mkdir: () => {
          throw new Error('EACCES');
        },
        rmdir: () => {
          throw new Error('ENOTEMPTY');
        },
      }),
    ).getPromiseFsClient().promises;
    await expect(failingMk.mkdir('/x')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(failingMk.rmdir('/x')).rejects.toMatchObject({ code: 'ENOTEMPTY' });
  });

  it('stat returns epoch defaults and real times when present', async () => {
    const withTimes = new IsoGitFs(
      fakeDofs({
        stat: () => ({
          isFile: false,
          isDirectory: true,
          size: 0,
          mode: 0o040000,
          atime: '2024-01-02T00:00:00.000Z',
          mtime: '2024-01-03T00:00:00.000Z',
          ctime: '2024-01-04T00:00:00.000Z',
          crtime: '2024-01-01T00:00:00.000Z',
        }),
      }),
    ).getPromiseFsClient().promises;
    const st = await withTimes.stat('/d');
    expect(st.isDirectory()).toBe(true);
    expect(st.mtime.getTime()).toBe(new Date('2024-01-03T00:00:00.000Z').getTime());
    expect(st.birthtime.getTime()).toBe(new Date('2024-01-01T00:00:00.000Z').getTime());
    expect(st.isSymbolicLink()).toBe(false);
  });

  it('readlink and symlink delegate with annotated failures', async () => {
    const client = new IsoGitFs(fakeDofs()).getPromiseFsClient().promises;
    expect(await client.readlink('/link')).toBe('/target');
    await expect(client.readlink('/missing')).rejects.toMatchObject({ path: '/missing' });
    await expect(client.symlink('/t', '/p')).resolves.toBeUndefined();
    const failing = new IsoGitFs(
      fakeDofs({
        symlink: () => {
          throw new Error('EPERM');
        },
      }),
    ).getPromiseFsClient().promises;
    await expect(failing.symlink('/t', '/p')).rejects.toMatchObject({ code: 'EPERM' });
  });
});
