import { describe, expect, it, vi } from 'vitest';
import { ReadModelService } from '../apps/background/src/ReadModelService';

function fakeGit(overrides: Record<string, unknown> = {}) {
  return {
    listBranches: async () => ['main'],
    currentBranch: async () => 'main',
    listTags: async () => [],
    peelTag: async () => null,
    resolveRef: async (ref = 'HEAD') => (ref === 'missing' ? null : 'a'.repeat(40)),
    getTree: async () => [],
    getLastCommit: async () => ({ oid: 'a'.repeat(40) }),
    getLog: async () => [{ oid: 'a'.repeat(40) }],
    getBlob: async () => null,
    ...overrides,
  };
}

describe('ReadModelService.getOverview', () => {
  it('bundles branches, tags, fast tree, commits, and README in one call', async () => {
    const git = fakeGit({
      listTags: async () => [{ ref: 'refs/tags/v1.0.0', oid: 'b'.repeat(40) }],
      peelTag: async () => null,
      getTree: async () => [
        { path: 'README.md', type: 'blob', mode: '100644', oid: 'd'.repeat(40) },
        { path: 'src', type: 'tree', mode: '040000', oid: 'e'.repeat(40) },
      ],
      getBlob: async () => ({ oid: 'd'.repeat(40), content: new Uint8Array([104, 105]), size: 2, isBinary: false }),
    });
    const svc = new ReadModelService(git as never);
    const overview = await svc.getOverview({});
    expect(overview.branches).toEqual(['main']);
    expect(overview.currentBranch).toBe('main');
    expect(overview.resolvedRef).toBe('a'.repeat(40));
    expect(overview.tags).toEqual([
      { name: 'v1.0.0', ref: 'refs/tags/v1.0.0', oid: 'b'.repeat(40), peeledOid: null, type: 'lightweight' },
    ]);
    expect(overview.tree).toEqual([
      { path: 'README.md', type: 'blob', mode: '100644', oid: 'd'.repeat(40), lastCommit: null },
      { path: 'src', type: 'tree', mode: '040000', oid: 'e'.repeat(40), lastCommit: null },
    ]);
    expect(overview.commits).toEqual([{ oid: 'a'.repeat(40) }]);
    expect(overview.readme).toMatchObject({ path: 'README.md', oid: 'd'.repeat(40), isBinary: false });
    expect((overview.readme as { contentBase64?: string }).contentBase64).toBeTypeOf('string');
  });

  it('returns empty tree/commits/readme for an empty repo', async () => {
    const git = fakeGit({ resolveRef: async () => null, getLastCommit: async () => undefined });
    const svc = new ReadModelService(git as never);
    await expect(svc.getOverview({})).resolves.toMatchObject({
      branches: ['main'],
      resolvedRef: null,
      tree: [],
      commits: [],
      readme: null,
    });
  });

  it('skips README for subdirectory paths and when includeTags is false', async () => {
    const getBlob = vi.fn(async () => ({ oid: 'd'.repeat(40), content: new Uint8Array([1]), size: 1, isBinary: false }));
    const listTags = vi.fn(async () => [{ ref: 'refs/tags/v1.0.0', oid: 'b'.repeat(40) }]);
    const svc = new ReadModelService(fakeGit({ getBlob, listTags }) as never);
    const subdir = await svc.getOverview({ path: 'src' });
    expect(subdir.readme).toBeNull();
    expect(getBlob).not.toHaveBeenCalled();
    const noTags = await svc.getOverview({ includeTags: false });
    expect(noTags.tags).toEqual([]);
    expect(listTags).toHaveBeenCalledTimes(1);
  });

  it('omits bytes for oversized READMEs instead of inflating the payload', async () => {
    const git = fakeGit({
      getTree: async () => [{ path: 'README.md', type: 'blob', mode: '100644', oid: 'd'.repeat(40) }],
      getBlob: async () => ({ oid: 'd'.repeat(40), content: new Uint8Array([1, 2, 3]), size: 600 * 1024, isBinary: false }),
    });
    const svc = new ReadModelService(git as never);
    const overview = await svc.getOverview({});
    expect(overview.readme).toMatchObject({ path: 'README.md', truncated: true });
    expect((overview.readme as { contentBase64?: string }).contentBase64).toBeUndefined();
  });
});
