import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseFetchRequest,
  validateFetchRequestCounts,
  validateFetchRequestOids,
  validateFilterSpec,
  validateReceivePackCommands,
} from '@edge-git/git-protocol';
// NOTE: relative import bypasses packages/git-service/src/index.ts, which
// re-exports the `dofs` runtime (unparsable in the node test env).
import { GitService } from '../packages/git-service/src/GitService';

const OID = 'a'.repeat(40);
const ZERO = '0'.repeat(40);

describe('validateFilterSpec', () => {
  it('accepts the filters the pack collector implements', () => {
    for (const filter of [undefined, '', 'blob:none', 'blob:limit=10', 'blob:limit=0', 'tree:0']) {
      expect(validateFilterSpec(filter)).toBeNull();
    }
  });

  it('rejects unsupported filters instead of silently sending full packs', () => {
    for (const filter of ['object:type=commit', 'blob:limit=', 'blob:limit=-3', 'tree:1', 'sparse:oid=abc', 'blob:none extra']) {
      expect(validateFilterSpec(filter)).not.toBeNull();
    }
    expect(validateFilterSpec('object:type=commit')).toContain('unsupported filter');
    expect(validateFilterSpec('  blob:none  ')).toBeNull();
  });
});

describe('validateFetchRequestOids', () => {
  it('accepts full-length oids', () => {
    const req = parseFetchRequest(new Uint8Array(), [`want ${OID}`, `have ${'b'.repeat(40)}`, `shallow ${'c'.repeat(40)}`]);
    expect(validateFetchRequestOids(req)).toBeNull();
  });

  it('rejects malformed want, have, and shallow oids', () => {
    expect(validateFetchRequestOids(parseFetchRequest(new Uint8Array(), ['want short']))).toContain('invalid want oid');
    expect(validateFetchRequestOids(parseFetchRequest(new Uint8Array(), [`want ${OID}`, 'have xyz']))).toContain('invalid have oid');
    expect(validateFetchRequestOids(parseFetchRequest(new Uint8Array(), [`want ${OID}`, `shallow ${ZERO.slice(0, 8)}`]))).toContain(
      'invalid shallow oid',
    );
  });
});

describe('validateFetchRequestCounts shallow lines', () => {
  it('caps client shallow lines like haves', () => {
    const many = Array.from({ length: 3 }, (_, i) => `shallow ${`${i}`.repeat(40)}`);
    const req = parseFetchRequest(new Uint8Array(), [`want ${OID}`, ...many]);
    expect(validateFetchRequestCounts(req, { maxWants: 64, maxHaves: 2 })).toContain('too many shallow lines');
  });
});

describe('validateReceivePackCommands', () => {
  it('accepts create, update, and delete commands on well-formed refs', () => {
    expect(
      validateReceivePackCommands([
        { oldOid: ZERO, newOid: OID, ref: 'refs/heads/feature/x' },
        { oldOid: OID, newOid: 'b'.repeat(40), ref: 'refs/heads/main' },
        { oldOid: OID, newOid: ZERO, ref: 'refs/tags/v1' },
      ]),
    ).toBeNull();
  });

  it('rejects malformed oids and unsafe ref names', () => {
    const bad: Array<{ oldOid: string; newOid: string; ref: string }> = [
      { oldOid: 'short', newOid: OID, ref: 'refs/heads/main' },
      { oldOid: ZERO, newOid: OID, ref: 'main' },
      { oldOid: ZERO, newOid: OID, ref: 'refs/heads/../evil' },
      { oldOid: ZERO, newOid: OID, ref: 'refs/heads/has space' },
      { oldOid: ZERO, newOid: OID, ref: 'refs/heads/x.lock' },
    ];
    for (const cmd of bad) {
      expect(validateReceivePackCommands([cmd])).not.toBeNull();
    }
  });
});

describe('PackCollector deepen-relative', () => {
  const tmpDirs: string[] = [];
  afterEach(async () => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop();
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  async function makeLinearRepo(commits: number): Promise<{ svc: GitService; oids: string[] }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'edge-git-relative-'));
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

  it('cuts the boundary one level deeper than the client shallow', async () => {
    const { svc, oids } = await makeLinearRepo(5);
    const tip = oids[4];
    const absolute = await svc.collectObjectsForPack([tip], [], { depth: 1 });
    expect(absolute.shallow).toEqual([tip]);
    const relative = await svc.collectObjectsForPack([tip], [], { depth: 1, deepenRelative: true, relativeTo: [oids[2]] });
    expect(relative.shallow).toEqual([oids[1]]);
    expect(relative.oids).toContain(oids[2]);
  });

  it('falls back to absolute depth when the boundary is unreachable', async () => {
    const { svc, oids } = await makeLinearRepo(3);
    const tip = oids[2];
    const result = await svc.collectObjectsForPack([tip], [], { depth: 1, deepenRelative: true, relativeTo: ['f'.repeat(40)] });
    expect(result.shallow).toEqual([tip]);
  });

  it('ignores the relative flag without a depth or boundary', async () => {
    const { svc, oids } = await makeLinearRepo(3);
    const tip = oids[2];
    const noDepth = await svc.collectObjectsForPack([tip], [], { deepenRelative: true, relativeTo: [oids[0]] });
    expect(noDepth.shallow).toEqual([]);
    expect(noDepth.oids).toContain(oids[0]);
  });

  it('traverses through haves under depth requests so deepen keeps working', async () => {
    // A `git fetch --deepen` client sends have lines for its truncated
    // history. Pruning traversal at those haves would return an empty pack
    // with no boundary ("remote did not send all necessary objects").
    const { svc, oids } = await makeLinearRepo(5);
    const tip = oids[4];
    const relative = await svc.collectObjectsForPack([tip], [tip], { depth: 1, deepenRelative: true, relativeTo: [tip] });
    expect(relative.shallow).toEqual([oids[3]]);
    expect(relative.oids).toContain(oids[3]);
    expect(relative.oids).not.toContain(tip);
  });

  it('still prunes haves for fetches without a depth bound', async () => {
    const { svc, oids } = await makeLinearRepo(3);
    const tip = oids[2];
    const result = await svc.collectObjectsForPack([tip], [tip]);
    expect(result.oids).toEqual([]);
    expect(result.shallow).toEqual([]);
  });
});
