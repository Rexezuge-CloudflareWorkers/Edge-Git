import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { describe, expect, it } from 'vitest';
import {
  ZERO_OID,
  branchRefFor,
  classifyRefCommand,
  isCommitOid,
  isCreateCommand,
  isDeleteCommand,
  isValidBranchName,
  isZeroOid,
} from '../packages/git-service/src/RefValidation';
import { RefService } from '../packages/git-service/src/RefService';

describe('harden: RefValidation policy (extracted from RefService)', () => {
  it('classifies receive-pack commands', () => {
    const oid = 'a'.repeat(40);
    expect(classifyRefCommand({ oldOid: ZERO_OID, newOid: oid, ref: 'refs/heads/main' })).toBe('create');
    expect(classifyRefCommand({ oldOid: oid, newOid: ZERO_OID, ref: 'refs/heads/old' })).toBe('delete');
    expect(classifyRefCommand({ oldOid: oid, newOid: 'b'.repeat(40), ref: 'refs/heads/main' })).toBe('update');
    expect(isDeleteCommand({ oldOid: oid, newOid: ZERO_OID, ref: 'r' })).toBe(true);
    expect(isCreateCommand({ oldOid: ZERO_OID, newOid: oid, ref: 'r' })).toBe(true);
  });

  it('validates OIDs strictly', () => {
    expect(isCommitOid('a'.repeat(40))).toBe(true);
    expect(isCommitOid('A'.repeat(40))).toBe(true);
    expect(isCommitOid(ZERO_OID)).toBe(true);
    expect(isCommitOid('short')).toBe(false);
    expect(isCommitOid(42)).toBe(false);
    expect(isZeroOid(ZERO_OID)).toBe(true);
    expect(isZeroOid('a'.repeat(40))).toBe(false);
  });

  it('builds branch refs and reuses the canonical branch rule', () => {
    expect(branchRefFor('main')).toBe('refs/heads/main');
    expect(isValidBranchName('feature/x')).toBe(true);
    expect(isValidBranchName('')).toBe(false);
    expect(isValidBranchName('a..b')).toBe(false);
  });

  it('honors the injected gitdir in applyRefUpdates (no /repo hardcode)', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-refdir-'));
    try {
      await git.init({ fs, dir, defaultBranch: 'main' });
      await fs.promises.writeFile(path.join(dir, 'a.txt'), 'hello\n');
      await git.add({ fs, dir, filepath: 'a.txt' });
      const c1 = await git.commit({
        fs,
        dir,
        author: { name: 't', email: 't@example.com' },
        message: 'one',
      });
      await fs.promises.writeFile(path.join(dir, 'a.txt'), 'hello2\n');
      await git.add({ fs, dir, filepath: 'a.txt' });
      const c2 = await git.commit({
        fs,
        dir,
        author: { name: 't', email: 't@example.com' },
        message: 'two',
      });
      const svc = new RefService(fs as never, path.join(dir, '.git'));
      const created = await svc.createBranch('feat', c1);
      expect(created).toEqual({ ok: true, ref: 'refs/heads/feat', oid: c1 });
      await expect(svc.applyRefUpdates([{ oldOid: c1, newOid: c2, ref: 'refs/heads/feat' }], false)).resolves.toEqual([
        { ref: 'refs/heads/feat', ok: true },
      ]);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
