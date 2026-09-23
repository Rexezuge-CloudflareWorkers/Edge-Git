import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as git from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';
import ts from 'typescript';
// NOTE: relative imports bypass packages/git-service/src/index.ts, which
// re-exports the `dofs` runtime (unparsable in the node unit pool:
// `cloudflare:*` ESM scheme). DofsFsAdapter itself is loaded below via
// transpile-with-fake-`dofs` so its real logic runs without the real module.
import { IsoGitFs } from '../packages/git-service/src/IsoGitFs';
import { normalizePath } from '../packages/git-service/src/ErrorNormalizer';
import { RefService } from '../packages/git-service/src/RefService';
import { GitService } from '../packages/git-service/src/GitService';
import { PackLimitError } from '../packages/git-service/src/PackLimits';
import { TreeReader } from '../packages/git-service/src/TreeReader';

const ZERO_OID = '0'.repeat(40);

function fakeDevice(seen: string[] = []) {
  const mem = new Map<string, Uint8Array>([['/b.txt', new TextEncoder().encode('hi')]]);
  return {
    read: (p: string) => {
      seen.push(`read:${p}`);
      const v = mem.get(p);
      if (!v) throw new Error('ENOENT');
      return v;
    },
    writeFile: (p: string, data: ArrayBuffer | string) => {
      seen.push(`write:${p}`);
      mem.set(p, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
    },
    unlink: (p: string) => {
      seen.push(`unlink:${p}`);
    },
    listDir: (p: string) => {
      seen.push(`readdir:${p}`);
      return ['.', '..', 'a.txt'];
    },
    mkdir: (p: string) => {
      seen.push(`mkdir:${p}`);
    },
    rmdir: (p: string) => {
      seen.push(`rmdir:${p}`);
    },
    stat: (p: string) => {
      seen.push(`stat:${p}`);
      return { isFile: true, isDirectory: false, size: 2, mode: 0o100644 } as never;
    },
    readlink: (p: string) => {
      seen.push(`readlink:${p}`);
      throw new Error('ENOENT');
    },
    symlink: () => undefined,
  } as never;
}

/** Load the real DofsFsAdapter module with a fake `dofs` (no real import). */
function loadAdapter() {
  const src = fs.readFileSync(new URL('../packages/git-service/src/DofsFsAdapter.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const ctorArgs: unknown[][] = [];
  const sizes: number[] = [];
  class FakeFs {
    public constructor(...args: unknown[]) {
      ctorArgs.push(args);
    }

    public setDeviceSize(n: number): void {
      sizes.push(n);
    }
  }
  const nodeRequire = createRequire(import.meta.url);
  const fakeRequire = (id: string) => (id === 'dofs' ? { Fs: FakeFs } : nodeRequire(id));
  const mod = { exports: {} as Record<string, never> };
  new Function('require', 'exports', 'module', outputText)(fakeRequire, mod.exports, mod);
  return {
    adapter: mod.exports as unknown as {
      createDofsFs(c: unknown, e: unknown, o?: unknown): unknown;
      setDofsDeviceSize(d: unknown, n: number): void;
      DEFAULT_CHUNK_SIZE: number;
    },
    ctorArgs,
    sizes,
    FakeFs,
  };
}

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

describe('DofsFsAdapter without real dofs', () => {
  it('exposes the documented default chunk size without importing dofs', () => {
    const { adapter } = loadAdapter();
    expect(adapter.DEFAULT_CHUNK_SIZE).toBe(512 * 1024);
  });

  it('createDofsFs forwards ctx/env with the default chunk size', () => {
    const { adapter, ctorArgs, FakeFs } = loadAdapter();
    const ctx = { id: 'ctx' };
    const env = { id: 'env' };
    const inst = adapter.createDofsFs(ctx, env);
    expect(inst).toBeInstanceOf(FakeFs);
    expect(ctorArgs).toHaveLength(1);
    expect(ctorArgs[0][0]).toBe(ctx);
    expect(ctorArgs[0][1]).toBe(env);
    expect(ctorArgs[0][2]).toEqual({ chunkSize: 512 * 1024 });
  });

  it('createDofsFs honors an explicit chunkSize override', () => {
    const { adapter, ctorArgs } = loadAdapter();
    adapter.createDofsFs({}, {}, { chunkSize: 4096 });
    expect(ctorArgs[0][2]).toEqual({ chunkSize: 4096 });
  });

  it('setDofsDeviceSize forwards the size on success', () => {
    const { adapter, sizes } = loadAdapter();
    const device = new (class {
      public setDeviceSize(n: number): void {
        sizes.push(n * 2);
      }
    })();
    adapter.setDofsDeviceSize(device, 1024);
    expect(sizes).toEqual([2048]);
  });

  it('setDofsDeviceSize swallows device failures (best-effort)', () => {
    const { adapter } = loadAdapter();
    const failing = {
      setDeviceSize: () => {
        throw new Error('ENOSPC');
      },
    };
    expect(() => adapter.setDofsDeviceSize(failing, 5)).not.toThrow();
    expect(() => adapter.setDofsDeviceSize({}, 5)).not.toThrow();
  });

  it('adapter source keeps the swallow so write paths surface real errors', () => {
    const src = fs.readFileSync(new URL('../packages/git-service/src/DofsFsAdapter.ts', import.meta.url), 'utf8');
    expect(src).toContain('setDeviceSize');
    expect(src).toMatch(/try\s*\{[\s\S]*setDeviceSize[\s\S]*\}\s*catch/);
  });
});

describe('git-service fs path handling', () => {
  it('normalizePath collapses traversal above root (no escape)', () => {
    expect(normalizePath('/a/../../..')).toBe('/');
    expect(normalizePath('/repo/../..')).toBe('/');
    expect(normalizePath('..\\..\\etc')).toBe('/etc');
    expect(normalizePath('/a/./b/../c')).toBe('/a/c');
  });

  it('IsoGitFs normalizes traversal paths before touching the device', async () => {
    const seen: string[] = [];
    const client = new IsoGitFs(fakeDevice(seen)).getPromiseFsClient().promises;
    await client.readFile('/a/../b.txt', 'utf8');
    await client.writeFile('sub\\..\\b.txt', new TextEncoder().encode('x'));
    await client.mkdir('//x/./y');
    expect(seen).toContain('read:/b.txt');
    expect(seen).toContain('write:/b.txt');
    expect(seen).toContain('mkdir:/x/y');
    expect(seen.some((s) => s.includes('..') || s.includes('\\'))).toBe(false);
  });
});

describe('RefService refs', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeRepo(commits = 2): Promise<{ dir: string; gitdir: string; oids: string[]; svc: RefService }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-refsvc-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    const oids: string[] = [];
    for (let i = 0; i < commits; i++) {
      await fs.promises.writeFile(path.join(dir, 'f.txt'), `rev ${i}\n`);
      await git.add({ fs, dir, filepath: 'f.txt' });
      oids.push(await git.commit({ fs, dir, author: { name: 'tester', email: 'tester@example.com' }, message: `rev ${i}` }));
    }
    const gitdir = path.join(dir, '.git');
    return { dir, gitdir, oids, svc: new RefService(redirectClient(gitdir) as never, '/repo') };
  }

  it('initRepo creates a bare repo whose HEAD symbolically points at main', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-init-'));
    tmpDirs.push(dir);
    const bareAt = path.join(dir, 'bare.git');
    const svc = new RefService(redirectClient(bareAt) as never, bareAt);
    await svc.initRepo();
    const head = await fs.promises.readFile(path.join(bareAt, 'HEAD'), 'utf8');
    expect(head).toContain('refs/heads/main');
    const listed = await new RefService(redirectClient(bareAt) as never, '/repo').listRefs();
    expect(listed.symbolicHead).toBe('refs/heads/main');
    expect(listed.refs).toEqual([]);
  });

  it('listRefs merges HEAD plus refs/heads and refs/tags namespaces', async () => {
    const { dir, oids, svc } = await makeRepo();
    await git.branch({ fs, dir, ref: 'feature', object: oids[0], checkout: false });
    await git.tag({ fs, dir, ref: 'v1', object: oids[1] });
    const { refs, symbolicHead } = await svc.listRefs();
    expect(symbolicHead).toBe('refs/heads/master');
    const byRef = new Map(refs.map((r) => [r.ref, r.oid]));
    expect(byRef.get('HEAD')).toBe(oids[1]);
    expect(byRef.get('refs/heads/master')).toBe(oids[1]);
    expect(byRef.get('refs/heads/feature')).toBe(oids[0]);
    expect(byRef.get('refs/tags/v1')).toBe(oids[1]);
    for (const r of refs) {
      expect(r.ref === 'HEAD' || r.ref.startsWith('refs/heads/') || r.ref.startsWith('refs/tags/')).toBe(true);
    }
  });

  it('listBranchesWithOid prefixes refs/heads and listTags prefixes refs/tags', async () => {
    const { dir, oids, svc } = await makeRepo();
    await git.branch({ fs, dir, ref: 'nested/x', object: oids[0], checkout: false });
    await git.tag({ fs, dir, ref: 'v2', object: oids[0] });
    const branches = await svc.listBranchesWithOid();
    expect(branches).toContainEqual({ ref: 'refs/heads/nested/x', oid: oids[0] });
    expect(branches.every((b) => b.ref.startsWith('refs/heads/'))).toBe(true);
    const tags = await svc.listTags();
    expect(tags).toContainEqual({ ref: 'refs/tags/v2', oid: oids[0] });
    expect(tags.every((t) => t.ref.startsWith('refs/tags/'))).toBe(true);
    expect(await svc.listBranches()).toContain('nested/x');
    expect(await svc.currentBranch()).toBe('master');
  });

  it('createBranch rejects malformed OIDs with unknown start point', async () => {
    const { svc } = await makeRepo(1);
    for (const bad of ['short', '', 'z'.repeat(40), 'a'.repeat(39), `${'a'.repeat(40)}extra`]) {
      await expect(svc.createBranch('feat', bad)).resolves.toEqual({ ok: false, error: 'unknown start point', status: 404 });
    }
    await expect(svc.createBranch('feat', 'd'.repeat(40))).resolves.toEqual({ ok: false, error: 'unknown start point', status: 404 });
  });

  it('createBranch rejects invalid branch names', async () => {
    const { oids, svc } = await makeRepo(1);
    for (const bad of ['', 'has space', '../evil', 'a//b', 'trailing.', '/leading', 'a..b']) {
      await expect(svc.createBranch(bad, oids[0])).resolves.toMatchObject({ ok: false, status: 400 });
    }
  });

  it('createBranch succeeds and rejects duplicates (lookup is case-sensitive)', async () => {
    const { oids, svc } = await makeRepo(1);
    await expect(svc.createBranch('Feat', oids[0])).resolves.toEqual({ ok: true, ref: 'refs/heads/Feat', oid: oids[0] });
    await expect(svc.createBranch('Feat', oids[0])).resolves.toEqual({ ok: false, error: 'branch already exists', status: 409 });
    await expect(svc.createBranch('Upper', oids[0].toUpperCase())).resolves.toEqual({
      ok: false,
      error: 'unknown start point',
      status: 404,
    });
  });

  it('deleteBranchRef validates, requires existence, and protects the current branch', async () => {
    const { oids, svc } = await makeRepo(1);
    await expect(svc.deleteBranchRef('has space')).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(svc.deleteBranchRef('nope')).resolves.toEqual({ ok: false, error: 'branch not found', status: 404 });
    await expect(svc.deleteBranchRef('master')).resolves.toEqual({ ok: false, error: 'cannot delete the default branch', status: 409 });
    await expect(svc.createBranch('spare', oids[0])).resolves.toMatchObject({ ok: true });
    await expect(svc.deleteBranchRef('spare')).resolves.toEqual({ ok: true, ref: 'refs/heads/spare' });
  });

  it('setDefaultBranch validates, requires existence, and repoints symbolic HEAD', async () => {
    const { oids, svc } = await makeRepo(1);
    await expect(svc.setDefaultBranch('has space')).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(svc.setDefaultBranch('nope')).resolves.toEqual({ ok: false, error: 'branch not found', status: 404 });
    await svc.createBranch('primary', oids[0]);
    await expect(svc.setDefaultBranch('primary')).resolves.toEqual({ ok: true, defaultBranch: 'primary' });
    expect((await svc.listRefs()).symbolicHead).toBe('refs/heads/primary');
    await expect(svc.deleteBranchRef('master')).resolves.toMatchObject({ ok: true });
  });

  it('resolveRef returns OIDs and null for missing refs', async () => {
    const { oids, svc } = await makeRepo(2);
    expect(await svc.resolveRef('HEAD')).toBe(oids[1]);
    expect(await svc.resolveRef('refs/heads/master')).toBe(oids[1]);
    expect(await svc.resolveRef('refs/heads/nope')).toBeNull();
  });

  it('returns every ref without a silent count cap', async () => {
    const { oids, svc } = await makeRepo(1);
    for (let i = 0; i < 25; i++) await svc.createBranch(`bulk/${i}`, oids[0]);
    const { refs } = await svc.listRefs();
    const heads = refs.filter((r) => r.ref.startsWith('refs/heads/'));
    expect(heads).toHaveLength(26);
  });
});

describe('RefService applyRefUpdates', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeChain(): Promise<{ svc: RefService; c1: string; c2: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-apply-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'v1');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const c1 = await git.commit({ fs, dir, author: { name: 't', email: 't@e.com' }, message: 'c1' });
    await fs.promises.writeFile(path.join(dir, 'f.txt'), 'v2');
    await git.add({ fs, dir, filepath: 'f.txt' });
    const c2 = await git.commit({ fs, dir, author: { name: 't', email: 't@e.com' }, message: 'c2' });
    const svc = new RefService(redirectClient(path.join(dir, '.git')) as never, '/repo');
    await expect(svc.createBranch('feat', c1)).resolves.toMatchObject({ ok: true });
    return { svc, c1, c2 };
  }

  it('fast-forwards matching updates and persists the new OID', async () => {
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

  it('creates missing refs and reports existing or absent refs', async () => {
    const { svc, c1 } = await makeChain();
    await expect(svc.applyRefUpdates([{ oldOid: ZERO_OID, newOid: c1, ref: 'refs/heads/new' }], false)).resolves.toEqual([
      { ref: 'refs/heads/new', ok: true },
    ]);
    expect(await svc.resolveRef('refs/heads/new')).toBe(c1);
    await expect(svc.applyRefUpdates([{ oldOid: ZERO_OID, newOid: c1, ref: 'refs/heads/new' }], false)).resolves.toEqual([
      { ref: 'refs/heads/new', ok: false, error: 'ref already exists' },
    ]);
    await expect(svc.applyRefUpdates([{ oldOid: c1, newOid: ZERO_OID, ref: 'refs/heads/ghost' }], false)).resolves.toEqual([
      { ref: 'refs/heads/ghost', ok: false, error: "ref doesn't exist" },
    ]);
  });

  it('deletes existing refs', async () => {
    const { svc, c1 } = await makeChain();
    await expect(svc.applyRefUpdates([{ oldOid: c1, newOid: ZERO_OID, ref: 'refs/heads/feat' }], false)).resolves.toEqual([
      { ref: 'refs/heads/feat', ok: true },
    ]);
    expect(await svc.resolveRef('refs/heads/feat')).toBeNull();
  });

  it('atomic mode fails every command when any command fails', async () => {
    const { svc, c1, c2 } = await makeChain();
    const results = await svc.applyRefUpdates(
      [
        { oldOid: c1, newOid: c2, ref: 'refs/heads/feat' },
        { oldOid: c1, newOid: c1, ref: 'refs/heads/ghost' },
      ],
      true,
    );
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results[1]).toMatchObject({ ref: 'refs/heads/ghost' });
    expect(await svc.resolveRef('refs/heads/feat')).toBe(c1);
  });
});

describe('GitService delegation', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeSvc(
    files: Record<string, string> = { 'hello.txt': 'hello\n' },
  ): Promise<{ svc: GitService; dir: string; gitdir: string; commitOid: string; blobOid: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-svc-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    for (const [name, content] of Object.entries(files)) {
      await fs.promises.writeFile(path.join(dir, name), content);
      await git.add({ fs, dir, filepath: name });
    }
    const commitOid = await git.commit({ fs, dir, author: { name: 'tester', email: 'tester@example.com' }, message: 'init' });
    const gitdir = path.join(dir, '.git');
    const svc = new GitService(fs as never, gitdir);
    const first = Object.keys(files)[0];
    const { oid: blobOid } = await git.readBlob({ fs, dir, oid: commitOid, filepath: first });
    return { svc, dir, gitdir, commitOid, blobOid };
  }

  it('listRefs and resolveRef delegate to the ref service', async () => {
    const { svc, commitOid } = await makeSvc();
    const { refs, symbolicHead } = await svc.listRefs();
    expect(refs).toContainEqual({ ref: 'HEAD', oid: commitOid });
    expect(refs).toContainEqual({ ref: 'refs/heads/master', oid: commitOid });
    expect(symbolicHead === null || typeof symbolicHead === 'string').toBe(true);
    expect(await svc.resolveRef('HEAD')).toBe(commitOid);
    expect(await svc.resolveRef('refs/heads/master')).toBe(commitOid);
    expect(await svc.resolveRef('refs/heads/nope')).toBeNull();
  });

  it('branch lifecycle delegates to the ref service', async () => {
    const { svc, commitOid } = await makeSvc();
    await expect(svc.createBranch('delegated', commitOid)).resolves.toMatchObject({ ok: true, ref: 'refs/heads/delegated' });
    expect(await svc.listBranches()).toContain('delegated');
    expect((await svc.listBranchesWithOid()).find((b) => b.ref === 'refs/heads/delegated')?.oid).toBe(commitOid);
    await expect(svc.deleteBranchRef('delegated')).resolves.toMatchObject({ ok: true });
    expect(await svc.listBranches()).not.toContain('delegated');
  });

  it('collectObjectsForPack and packObjects delegate pack paths', async () => {
    const { svc, commitOid, blobOid } = await makeSvc();
    const collected = await svc.collectObjectsForPack([commitOid], []);
    expect(collected.oids).toContain(commitOid);
    expect(collected.oids).toContain(blobOid);
    const pack = (await svc.packObjects([commitOid])) as unknown as Uint8Array;
    expect(pack).toBeInstanceOf(Uint8Array);
    expect(pack.length).toBeGreaterThan(0);
  });

  it('indexPack delegates the pack file path through to storage', async () => {
    const { svc, gitdir, commitOid } = await makeSvc();
    const pack = (await svc.packObjects([commitOid])) as unknown as Uint8Array;
    const rel = 'objects/pack/delegation.pack';
    await fs.promises.writeFile(path.join(gitdir, rel), Buffer.from(pack));
    await expect(svc.indexPack(rel)).resolves.toBeUndefined();
    expect(await svc.hasObject(commitOid)).toBe(true);
  });

  it('getTree and getBlob delegate nested paths', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-nest-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.mkdir(path.join(dir, 'a', 'b'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'a', 'b', 'c.txt'), 'deep');
    await git.add({ fs, dir, filepath: 'a/b/c.txt' });
    const oid = await git.commit({ fs, dir, author: { name: 't', email: 't@e.com' }, message: 'm' });
    const svc = new GitService(fs as never, path.join(dir, '.git'));
    const root = (await svc.getTree(oid)) as Array<{ path: string; type: string }>;
    expect(root.map((e) => e.path).sort()).toEqual(['a']);
    const nested = (await svc.getTree(oid, 'a/b')) as Array<{ path: string }>;
    expect(nested.map((e) => e.path)).toEqual(['c.txt']);
    const blob = await svc.getBlob(oid, 'a/b/c.txt');
    expect(new TextDecoder().decode(blob?.content as Uint8Array)).toBe('deep');
  });

  it('hasObject, findCommonCommits, and history reads delegate', async () => {
    const { svc, commitOid } = await makeSvc();
    expect(await svc.hasObject(commitOid)).toBe(true);
    expect(await svc.hasObject('d'.repeat(40))).toBe(false);
    expect(await svc.findCommonCommits([commitOid, 'd'.repeat(40)])).toEqual([commitOid]);
    await expect(svc.findCommonCommits([commitOid, commitOid, commitOid], 2)).rejects.toBeInstanceOf(PackLimitError);
    expect((await svc.getLastCommit('master'))?.oid).toBe(commitOid);
    expect(await svc.getLog({ ref: 'master', depth: 1 })).toHaveLength(1);
    expect((await svc.getCommit(commitOid))?.commit?.commit.message).toBe('init\n');
  });

  it('readObject, expandRef, peelTag, and cache controls delegate', async () => {
    const { dir, svc, commitOid } = await makeSvc();
    expect((await svc.readObject(commitOid))?.type).toBe('commit');
    expect(await svc.readObject('d'.repeat(40))).toBeNull();
    expect(await svc.expandRef('refs/heads/master')).toBe('refs/heads/master');
    await git.annotatedTag({ fs, dir, ref: 'v1', object: commitOid, message: 'release', tagger: { name: 't', email: 't@e.com' } });
    const tagOid = await git.resolveRef({ fs, dir, ref: 'refs/tags/v1' });
    expect(await svc.peelTag(tagOid)).toBe(commitOid);
    expect(await svc.peelTag('d'.repeat(40))).toBeNull();
    expect(() => svc.clearCache()).not.toThrow();
    expect(() => svc.ensureFreshCache(3600)).not.toThrow();
  });
});

describe('TreeReader paths', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeNested(): Promise<{ reader: TreeReader; oid: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-tree-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.mkdir(path.join(dir, 'a', 'b'), { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'a', 'b', 'c.txt'), 'deep');
    await fs.promises.writeFile(path.join(dir, 'a', 'd.txt'), 'mid');
    await fs.promises.writeFile(path.join(dir, 'r.txt'), 'root');
    await fs.promises.writeFile(path.join(dir, 'bin.dat'), Buffer.from([104, 105, 0, 1]));
    for (const f of ['a/b/c.txt', 'a/d.txt', 'r.txt', 'bin.dat']) await git.add({ fs, dir, filepath: f });
    const oid = await git.commit({ fs, dir, author: { name: 't', email: 't@e.com' }, message: 'm' });
    return { reader: new TreeReader(fs as never, path.join(dir, '.git'), () => ({})), oid };
  }

  it('reads the root tree with entry paths', async () => {
    const { reader, oid } = await makeNested();
    const root = (await reader.getTree(oid, '')) as Array<{ path: string; type: string }>;
    expect(root.map((e) => e.path).sort()).toEqual(['a', 'bin.dat', 'r.txt']);
    expect(root.find((e) => e.path === 'a')?.type).toBe('tree');
  });

  it('reads nested trees segment by segment', async () => {
    const { reader, oid } = await makeNested();
    const a = (await reader.getTree(oid, 'a')) as Array<{ path: string; type: string }>;
    expect(a.map((e) => e.path).sort()).toEqual(['b', 'd.txt']);
    const ab = (await reader.getTree(oid, 'a/b')) as Array<{ path: string; type: string }>;
    expect(ab).toHaveLength(1);
    expect(ab[0]).toMatchObject({ path: 'c.txt', type: 'blob' });
  });

  it('returns an empty tree for unknown paths or revisions', async () => {
    const { reader, oid } = await makeNested();
    expect(await reader.getTree(oid, 'nope')).toEqual([]);
    expect(await reader.getTree(oid, 'r.txt')).toEqual([]);
    expect(await reader.getTree('d'.repeat(40), '')).toEqual([]);
  });

  it('reads blobs with size and text/binary flags', async () => {
    const { reader, oid } = await makeNested();
    const text = await reader.getBlob(oid, 'a/b/c.txt');
    expect(text).toMatchObject({ size: 4, isBinary: false });
    expect(new TextDecoder().decode(text?.content as Uint8Array)).toBe('deep');
    const bin = await reader.getBlob(oid, 'bin.dat');
    expect(bin).toMatchObject({ size: 4, isBinary: true });
    expect(await reader.getBlob(oid, 'missing.txt')).toBeNull();
  });

  it('detectBinary only scans the first 8000 bytes', () => {
    const reader = new TreeReader({} as never, '/repo', () => ({}));
    expect(reader.detectBinary(new Uint8Array([104, 105]))).toBe(false);
    expect(reader.detectBinary(new Uint8Array([1, 0, 2]))).toBe(true);
    expect(reader.detectBinary(new Uint8Array(0))).toBe(false);
    const late = new Uint8Array(8001).fill(65);
    late[8000] = 0;
    expect(reader.detectBinary(late)).toBe(false);
    const edge = new Uint8Array(8000).fill(65);
    edge[7999] = 0;
    expect(reader.detectBinary(edge)).toBe(true);
  });

  it('getBlobSize measures bytes', () => {
    const reader = new TreeReader({} as never, '/repo', () => ({}));
    expect(reader.getBlobSize(new Uint8Array(7))).toBe(7);
    expect(reader.getBlobSize(new TextEncoder().encode('hello'))).toBe(5);
  });
});

describe('PackCollector limits and filters', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeLinear(commits: number): Promise<{ svc: GitService; oids: string[] }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-pack-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    const oids: string[] = [];
    for (let i = 0; i < commits; i++) {
      await fs.promises.writeFile(path.join(dir, 'f.txt'), `rev ${i}\n`);
      await git.add({ fs, dir, filepath: 'f.txt' });
      oids.push(await git.commit({ fs, dir, author: { name: 'tester', email: 'tester@example.com' }, message: `rev ${i}` }));
    }
    return { svc: new GitService(fs as never, path.join(dir, '.git')), oids };
  }

  it('enforces maxObjects with PackLimitError', async () => {
    const { svc, oids } = await makeLinear(3);
    await expect(svc.collectObjectsForPack([oids[2]], [], { maxObjects: 0 })).rejects.toBeInstanceOf(PackLimitError);
    await expect(svc.collectObjectsForPack([oids[2]], [], { maxObjects: 0 })).rejects.toThrow('too many objects');
    await expect(svc.collectObjectsForPack([], [], { maxObjects: 10 })).resolves.toEqual({ oids: [], shallow: [] });
  });

  it('findCommonCommits filters unknown oids and caps haves', async () => {
    const { svc, oids } = await makeLinear(2);
    expect(await svc.findCommonCommits([oids[1], 'd'.repeat(40)])).toEqual([oids[1]]);
    expect(await svc.findCommonCommits([])).toEqual([]);
    await expect(svc.findCommonCommits([oids[0], oids[1]], 1)).rejects.toThrow('too many haves');
  });

  it('depth cutoff records the shallow boundary', async () => {
    const { svc, oids } = await makeLinear(4);
    const result = await svc.collectObjectsForPack([oids[3]], [], { depth: 1 });
    expect(result.shallow).toEqual([oids[3]]);
    expect(result.oids).toContain(oids[3]);
  });

  it('deepen-relative extends the cutoff from the client boundary', async () => {
    const { svc, oids } = await makeLinear(5);
    const relative = await svc.collectObjectsForPack([oids[4]], [], { depth: 2, deepenRelative: true, relativeTo: [oids[3]] });
    expect(relative.shallow).toEqual([oids[1]]);
    expect(relative.oids).toContain(oids[3]);
    expect(relative.oids).not.toContain(oids[0]);
  });

  it('blob:limit keeps blobs at the boundary and skips larger ones', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-bl-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    const content = '0123456789abcdef';
    await fs.promises.writeFile(path.join(dir, 'f.txt'), content);
    await git.add({ fs, dir, filepath: 'f.txt' });
    const commitOid = await git.commit({ fs, dir, author: { name: 't', email: 't@e.com' }, message: 'm' });
    const svc = new GitService(fs as never, path.join(dir, '.git'));
    const { oid: blobOid } = await git.readBlob({ fs, dir, oid: commitOid, filepath: 'f.txt' });
    const kept = await svc.collectObjectsForPack([commitOid], [], { filter: `blob:limit=${content.length}` });
    expect(kept.oids).toContain(blobOid);
    const skipped = await svc.collectObjectsForPack([commitOid], [], { filter: `blob:limit=${content.length - 1}` });
    expect(skipped.oids).not.toContain(blobOid);
    expect(skipped.oids).toContain(commitOid);
  });

  it('exclude prunes the unwanted subtree', async () => {
    const { svc, oids } = await makeLinear(3);
    const result = await svc.collectObjectsForPack([oids[2]], [], { exclude: [oids[2]] });
    expect(result).toEqual({ oids: [], shallow: [] });
  });

  it('since excludes history older than the cutoff', async () => {
    const { svc, oids } = await makeLinear(3);
    const future = Math.trunc(Date.now() / 1000) + 10_000;
    const result = await svc.collectObjectsForPack([oids[2]], [], { since: future });
    expect(result.oids).toEqual([oids[2]]);
    expect(result.shallow).toEqual([oids[2]]);
  });
});
