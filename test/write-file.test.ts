import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';
// NOTE: relative import bypasses packages/git-service/src/index.ts, which
// re-exports the `dofs` runtime (unparsable in the node test env).
import { WriteService, splitFilePath } from '../packages/git-service/src/WriteService';

describe('splitFilePath', () => {
  it('accepts nested relative paths', () => {
    expect(splitFilePath('a/b/c.txt')).toEqual({ ok: true, segments: ['a', 'b', 'c.txt'] });
  });

  it('rejects traversal, absolute paths, and .git segments', () => {
    for (const bad of ['', '../x', 'a/../../y', '/abs', 'a/', 'a//b', '.git/config', 'a/.Git/x', 'a/./b', 'a/.', '.']) {
      expect(splitFilePath(bad).ok, bad).toBe(false);
    }
  });
});

describe('WriteService commitFile', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeRepo(): Promise<{ svc: WriteService; dir: string; gitdir: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-write-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir, defaultBranch: 'main' });
    await fs.promises.writeFile(path.join(dir, 'base.txt'), 'base\n');
    await git.add({ fs, dir, filepath: 'base.txt' });
    await git.commit({ fs, dir, author: { name: 'tester', email: 'tester@example.com' }, message: 'init' });
    return { svc: new WriteService(fs as never, path.join(dir, '.git')), dir, gitdir: path.join(dir, '.git') };
  }

  async function makeEmptyRepo(): Promise<{ svc: WriteService; dir: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-write-empty-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir, defaultBranch: 'main' });
    return { svc: new WriteService(fs as never, path.join(dir, '.git')), dir };
  }

  const author = { name: 'tester', email: 'tester@example.com' };

  it('creates nested files and updates them', async () => {
    const { svc, gitdir } = await makeRepo();
    const created = await svc.commitFile({ branch: 'main', path: 'docs/note.txt', content: new TextEncoder().encode('hello\n'), message: 'Create docs/note.txt', author });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.created).toBe(true);
    const head = await git.resolveRef({ fs, gitdir, ref: 'refs/heads/main' });
    expect(head).toBe(created.commitOid);
    const blob = await git.readBlob({ fs, gitdir, oid: head, filepath: 'docs/note.txt' });
    expect(new TextDecoder().decode(blob.blob)).toBe('hello\n');

    const updated = await svc.commitFile({ branch: 'main', path: 'docs/note.txt', content: new TextEncoder().encode('v2\n'), message: 'Update docs/note.txt', author });
    expect(updated).toMatchObject({ ok: true, created: false, deleted: false });
  });

  it('is a no-op (same oid) for identical content', async () => {
    const { svc, gitdir } = await makeRepo();
    const before = await git.resolveRef({ fs, gitdir, ref: 'refs/heads/main' });
    const result = await svc.commitFile({ branch: 'main', path: 'base.txt', content: new TextEncoder().encode('base\n'), message: 'noop', author });
    expect(result).toEqual({ ok: true, commitOid: before, created: false, deleted: false });
  });

  it('deletes files and drops emptied directories', async () => {
    const { svc, gitdir } = await makeRepo();
    await svc.commitFile({ branch: 'main', path: 'docs/note.txt', content: new TextEncoder().encode('x\n'), message: 'add', author });
    const deleted = await svc.commitFile({ branch: 'main', path: 'docs/note.txt', content: null, message: 'Delete docs/note.txt', author });
    expect(deleted).toMatchObject({ ok: true, deleted: true });
    if (!deleted.ok) return;
    const { tree } = await git.readTree({ fs, gitdir, oid: (await git.readCommit({ fs, gitdir, oid: deleted.commitOid })).commit.tree });
    expect(tree.map((e) => e.path)).not.toContain('docs');
    await expect(svc.commitFile({ branch: 'main', path: 'docs/note.txt', content: null, message: 'again', author })).resolves.toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('creates the initial commit on an empty repo', async () => {
    const { svc, dir } = await makeEmptyRepo();
    const gitdir = path.join(dir, '.git');
    const result = await svc.commitFile({ branch: 'main', path: 'README.md', content: new TextEncoder().encode('# hi\n'), message: 'Create README.md', author });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(await git.resolveRef({ fs, gitdir, ref: 'refs/heads/main' })).toBe(result.commitOid);
    expect(await git.currentBranch({ fs, gitdir, fullname: false }).catch(() => 'main')).toBe('main');
  });

  it('enforces expectedOid optimistic concurrency', async () => {
    const { svc, gitdir } = await makeRepo();
    const tip = await git.resolveRef({ fs, gitdir, ref: 'refs/heads/main' });
    await expect(
      svc.commitFile({ branch: 'main', path: 'a.txt', content: new TextEncoder().encode('x\n'), message: 'm', author, expectedOid: '0'.repeat(40) }),
    ).resolves.toMatchObject({ ok: false, status: 409 });
    const ok = await svc.commitFile({ branch: 'main', path: 'a.txt', content: new TextEncoder().encode('x\n'), message: 'm', author, expectedOid: tip });
    expect(ok.ok).toBe(true);
  });

  it('rejects invalid branches, paths, authors, and messages', async () => {
    const { svc } = await makeRepo();
    const bytes = new TextEncoder().encode('x\n');
    await expect(svc.commitFile({ branch: 'bad..name', path: 'a.txt', content: bytes, message: 'm', author })).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(svc.commitFile({ branch: 'nope', path: 'a.txt', content: bytes, message: 'm', author })).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(svc.commitFile({ branch: 'main', path: '../evil', content: bytes, message: 'm', author })).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(svc.commitFile({ branch: 'main', path: 'a.txt', content: bytes, message: '  ', author })).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(svc.commitFile({ branch: 'main', path: 'a.txt', content: bytes, message: 'm', author: { name: '', email: 'x' } })).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it('rejects binary content and oversized files', async () => {
    const { svc } = await makeRepo();
    const binary = new Uint8Array([104, 105, 0, 1, 2]);
    await expect(svc.commitFile({ branch: 'main', path: 'bin.dat', content: binary, message: 'm', author })).resolves.toMatchObject({
      ok: false,
      status: 400,
    });
    await expect(svc.commitFile({ branch: 'main', path: 'big.txt', content: new Uint8Array(10), message: 'm', author, maxFileBytes: 4 })).resolves.toMatchObject({
      ok: false,
      status: 413,
    });
  });

  it('rejects writes through non-tree paths', async () => {
    const { svc } = await makeRepo();
    await expect(
      svc.commitFile({ branch: 'main', path: 'base.txt/nested.txt', content: new TextEncoder().encode('x\n'), message: 'm', author }),
    ).resolves.toMatchObject({ ok: false, status: 400 });
  });
});
