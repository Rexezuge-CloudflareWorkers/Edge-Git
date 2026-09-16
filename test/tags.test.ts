import { describe, expect, it } from 'vitest';
import { ReadModelService } from '../apps/background/src/ReadModelService';

function fakeGit(tags: Array<{ ref: string; oid: string }>, peeled: Record<string, string | null>) {
  return {
    listTags: async () => tags,
    peelTag: async (oid: string) => peeled[oid] ?? null,
  };
}

describe('ReadModelService.getTags', () => {
  it('enriches lightweight and annotated tags and sorts by name', async () => {
    const svc = new ReadModelService(
      fakeGit(
        [
          { ref: 'refs/tags/v2.0.0', oid: 'b'.repeat(40) },
          { ref: 'refs/tags/v1.0.0', oid: 'a'.repeat(40) },
        ],
        { ['a'.repeat(40)]: null, ['b'.repeat(40)]: 'c'.repeat(40) },
      ) as never,
    );
    await expect(svc.getTags()).resolves.toEqual([
      { name: 'v1.0.0', ref: 'refs/tags/v1.0.0', oid: 'a'.repeat(40), peeledOid: null, type: 'lightweight' },
      { name: 'v2.0.0', ref: 'refs/tags/v2.0.0', oid: 'b'.repeat(40), peeledOid: 'c'.repeat(40), type: 'annotated' },
    ]);
  });

  it('returns an empty list when the repo has no tags', async () => {
    const svc = new ReadModelService(fakeGit([], {}) as never);
    await expect(svc.getTags()).resolves.toEqual([]);
  });
});
