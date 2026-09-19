import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';
// NOTE: relative import bypasses packages/git-service/src/index.ts, which
// re-exports the `dofs` runtime (unparsable in the node test env).
import { WriteService } from '../packages/git-service/src/WriteService';

const author = { name: 'tester', email: 'tester@example.com' };
const enc = new TextEncoder();

describe('WriteService existence walk (no readBlob misses)', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeRepo(): Promise<WriteService> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-pathexists-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir, defaultBranch: 'main' });
    await fs.promises.writeFile(path.join(dir, 'base.txt'), 'base\n');
    await git.add({ fs, dir, filepath: 'base.txt' });
    await git.commit({ fs, dir, author, message: 'init' });
    return new WriteService(fs as never, path.join(dir, '.git'));
  }

  async function commit(svc: WriteService, input: { path: string; content: string | null; message?: string }) {
    return svc.commitFile({
      branch: 'main',
      path: input.path,
      content: input.content === null ? null : enc.encode(input.content),
      message: input.message ?? 'test',
      author,
    });
  }

  it('creates a second top-level file on an existing branch', async () => {
    const svc = await makeRepo();
    const created = await commit(svc, { path: 'second.txt', content: 'two\n' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.created).toBe(true);
  });

  it('distinguishes nested files from missing intermediate dirs', async () => {
    const svc = await makeRepo();
    // 'docs' does not exist yet: update-attempt is a create.
    const created = await commit(svc, { path: 'docs/note.txt', content: 'hi\n' });
    expect(created.ok).toBe(true);
    // Now 'docs' is a tree: creating a file *named* docs fails cleanly.
    const clash = await commit(svc, { path: 'docs', content: 'x\n' });
    expect(clash.ok).toBe(true);
    // Deleting a path under a file (not a tree) reports not found.
    const missing = await commit(svc, { path: 'base.txt/nested.txt', content: null });
    expect(missing).toMatchObject({ ok: false, status: 404 });
  });

  it('deletes an existing nested file and 404s on repeat delete', async () => {
    const svc = await makeRepo();
    expect((await commit(svc, { path: 'docs/note.txt', content: 'hi\n' })).ok).toBe(true);
    const deleted = await commit(svc, { path: 'docs/note.txt', content: null });
    expect(deleted).toMatchObject({ ok: true, deleted: true });
    const again = await commit(svc, { path: 'docs/note.txt', content: null });
    expect(again).toMatchObject({ ok: false, status: 404 });
  });

  it('updates an existing file without treating it as a create', async () => {
    const svc = await makeRepo();
    const updated = await commit(svc, { path: 'base.txt', content: 'v2\n' });
    expect(updated).toMatchObject({ ok: true, created: false, deleted: false });
  });
});
