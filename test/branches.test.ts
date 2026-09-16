import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';
// NOTE: relative import bypasses packages/git-service/src/index.ts, which
// re-exports the `dofs` runtime (unparsable in the node test env).
import { RefService } from '../packages/git-service/src/RefService';

describe('RefService branch lifecycle', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeRepo(): Promise<{ svc: RefService; head: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-branches-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir, defaultBranch: 'main' });
    await fs.promises.writeFile(path.join(dir, 'a.txt'), 'hello\n');
    await git.add({ fs, dir, filepath: 'a.txt' });
    const head = await git.commit({ fs, dir, author: { name: 'tester', email: 'tester@example.com' }, message: 'init' });
    return { svc: new RefService(fs as never, path.join(dir, '.git')), head };
  }

  it('creates a branch from a commit oid', async () => {
    const { svc, head } = await makeRepo();
    const created = await svc.createBranch('feature', head);
    expect(created).toEqual({ ok: true, ref: 'refs/heads/feature', oid: head });
    await expect(svc.createBranch('feature', head)).resolves.toEqual({ ok: false, error: 'branch already exists', status: 409 });
  });

  it('rejects invalid names and unknown start points', async () => {
    const { svc, head } = await makeRepo();
    await expect(svc.createBranch('bad..name', head)).resolves.toMatchObject({ ok: false, status: 400 });
    await expect(svc.createBranch('ok-name', '0'.repeat(40))).resolves.toMatchObject({ ok: false, status: 404 });
  });

  it('deletes branches but guards the default and missing refs', async () => {
    const { svc, head } = await makeRepo();
    await svc.createBranch('gone', head);
    await expect(svc.deleteBranchRef('gone')).resolves.toEqual({ ok: true, ref: 'refs/heads/gone' });
    await expect(svc.deleteBranchRef('gone')).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(svc.deleteBranchRef('main')).resolves.toMatchObject({ ok: false, status: 409 });
    await expect(svc.deleteBranchRef('bad..name')).resolves.toMatchObject({ ok: false, status: 400 });
  });

  it('moves the default branch only to existing branches', async () => {
    const { svc, head } = await makeRepo();
    await svc.createBranch('next', head);
    await expect(svc.setDefaultBranch('next')).resolves.toEqual({ ok: true, defaultBranch: 'next' });
    await expect(svc.currentBranch()).resolves.toBe('next');
    await expect(svc.setDefaultBranch('missing')).resolves.toMatchObject({ ok: false, status: 404 });
    await expect(svc.setDefaultBranch('bad..name')).resolves.toMatchObject({ ok: false, status: 400 });
  });
});
