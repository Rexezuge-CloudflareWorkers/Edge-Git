import { describe, expect, it, vi } from 'vitest';

// NOTE: relative import bypasses packages/git-service/src/index.ts, which
// pulls `dofs` → `cloudflare:*` (unavailable in the node unit pool).
import { ObjectReader } from '../packages/git-service/src/ObjectReader';

vi.mock('isomorphic-git', () => ({
  readObject: vi.fn(async ({ oid }: { oid: string }) => {
    if (oid === 'missing') throw new Error('not found');
    if (oid === 'json-object') return { type: 'blob', object: { hello: 'world' } };
    return { type: 'blob', object: new Uint8Array([1, 2, 3]) };
  }),
  expandRef: vi.fn(async ({ ref }: { ref: string }) => {
    if (ref === 'refs/heads/main') return 'refs/heads/main';
    throw new Error('nope');
  }),
  readTag: vi.fn(async ({ oid }: { oid: string }) => {
    if (oid === 'tag-oid') return { tag: { object: 'target-oid' } };
    throw new Error('nope');
  }),
}));

describe('ObjectReader edges', () => {
  it('caches and clears on demand; TTL expiry clears', async () => {
    const reader = new ObjectReader({} as never, '/repo');
    expect(await reader.readObject('abc')).toBeDefined();
    reader.clearCache();
    expect(await reader.readObject('abc')).toBeDefined();
    reader.ensureFreshCache(0); // non-positive TTL is a no-op
    reader.ensureFreshCache(Number.NaN);
    expect(await reader.hasObject('abc')).toBe(true);
    expect(await reader.hasObject('missing')).toBe(false);
  });

  it('readObject returns null on missing', async () => {
    const reader = new ObjectReader({} as never, '/repo');
    expect(await reader.readObject('missing')).toBeNull();
  });

  it('readObjectForLsRefs passes through string/bytes, JSON-encodes objects', async () => {
    const reader = new ObjectReader({} as never, '/repo');
    const bytes = await reader.readObjectForLsRefs('abc');
    expect(bytes?.object).toBeInstanceOf(Uint8Array);
    const json = await reader.readObjectForLsRefs('json-object');
    expect(new TextDecoder().decode(json?.object as Uint8Array)).toContain('hello');
    expect(await reader.readObjectForLsRefs('missing')).toBeNull();
  });

  it('expandRef/peelTag null on failure', async () => {
    const reader = new ObjectReader({} as never, '/repo');
    expect(await reader.expandRef('refs/heads/main')).toBe('refs/heads/main');
    expect(await reader.expandRef('refs/heads/nope')).toBeNull();
    expect(await reader.peelTag('tag-oid')).toBe('target-oid');
    expect(await reader.peelTag('nope')).toBeNull();
  });
});
