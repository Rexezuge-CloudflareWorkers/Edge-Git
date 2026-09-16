import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';
// NOTE: relative imports bypass packages/git-service/src/index.ts, which
// re-exports the `dofs` runtime (unparsable in the node test env).
import { computeHunks, diffText } from '../packages/git-service/src/DiffHunks';
import { HistoryService } from '../packages/git-service/src/HistoryService';

describe('computeHunks', () => {
  it('returns no hunks for identical text', () => {
    expect(computeHunks('a\nb\n', 'a\nb\n')).toEqual([]);
  });

  it('produces one hunk for a single-line change with context', () => {
    const hunks = computeHunks('a\nb\nc\nd\ne\n', 'a\nB\nc\nd\ne\n');
    expect(hunks).toHaveLength(1);
    const [hunk] = hunks;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.lines.map((l) => l.kind)).toEqual(['context', 'remove', 'add', 'context', 'context', 'context']);
    expect(hunk.lines.find((l) => l.kind === 'remove')).toMatchObject({ text: 'b', oldNo: 2, newNo: null });
    expect(hunk.lines.find((l) => l.kind === 'add')).toMatchObject({ text: 'B', oldNo: null, newNo: 2 });
  });

  it('renders a whole-file add with new-side line numbers', () => {
    const hunks = computeHunks('', 'l1\nl2\n');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.map((l) => l.kind)).toEqual(['add', 'add']);
    expect(hunks[0].lines.map((l) => l.newNo)).toEqual([1, 2]);
  });

  it('splits far-apart changes into separate hunks', () => {
    const oldText = `${Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')}\n`;
    const newText = oldText.replace('line2', 'LINE2').replace('line27', 'LINE27');
    const hunks = computeHunks(oldText, newText);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].lines.some((l) => l.text === 'LINE2')).toBe(true);
    expect(hunks[1].lines.some((l) => l.text === 'LINE27')).toBe(true);
  });
});

describe('diffText', () => {
  it('flags oversized files instead of diffing', () => {
    const big = Array.from({ length: 3000 }, () => 'x').join('\n');
    expect(diffText(big, `${big}\ny`).tooLarge).toBe(true);
    expect(diffText('a\n', 'b\n')).toEqual({ tooLarge: false, hunks: expect.any(Array) });
  });
});

describe('HistoryService commit and compare diffs', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeRepo(): Promise<{ svc: HistoryService; first: string; second: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-diff-'));
    tmpDirs.push(dir);
    await git.init({ fs, dir });
    await fs.promises.writeFile(path.join(dir, 'notes.txt'), 'one\ntwo\nthree\n');
    await git.add({ fs, dir, filepath: 'notes.txt' });
    const first = await git.commit({ fs, dir, author: { name: 'tester', email: 'tester@example.com' }, message: 'first' });
    await fs.promises.writeFile(path.join(dir, 'notes.txt'), 'one\nTWO\nthree\nfour\n');
    await git.add({ fs, dir, filepath: 'notes.txt' });
    const second = await git.commit({ fs, dir, author: { name: 'tester', email: 'tester@example.com' }, message: 'second' });
    return { svc: new HistoryService(fs as never, path.join(dir, '.git')), first, second };
  }

  it('returns commit metadata plus hunks for the second commit', async () => {
    const { svc, second } = await makeRepo();
    const result = (await svc.getCommitDiff(second, 10)) as { commit: { oid: string } | null; truncated: boolean; files: Array<{ path: string; hunks: unknown[] }> };
    expect(result.commit).toMatchObject({ oid: second });
    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe('notes.txt');
    expect(result.files[0].hunks).toHaveLength(1);
  });

  it('reports a missing commit as null', async () => {
    const { svc } = await makeRepo();
    const result = (await svc.getCommitDiff('0'.repeat(40), 10)) as { commit: null };
    expect(result.commit).toBeNull();
  });

  it('compares refs three-dot via the merge base', async () => {
    const { svc, first, second } = await makeRepo();
    const result = (await svc.getCompareDiff(first, second, 10)) as { baseOid: string; headOid: string; mergeBase: string | null; files: unknown[] } | null;
    expect(result).not.toBeNull();
    expect(result).toMatchObject({ baseOid: first, headOid: second, mergeBase: first });
    expect(result?.files).toHaveLength(1);
  });

  it('returns null when either compare ref is unknown', async () => {
    const { svc, second } = await makeRepo();
    await expect(svc.getCompareDiff('nope', second, 10)).resolves.toBeNull();
  });
});
