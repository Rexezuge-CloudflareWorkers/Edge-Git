import { describe, expect, it, vi } from 'vitest';
import { createKvCache } from '@edge-git/backend-runtime/kv';
import type { KvNamespaceLike } from '@edge-git/backend-runtime/kv';
import { buildKvKey, clampTtl, KV_DOMAINS, KV_MAX_KEY_LENGTH } from '@edge-git/backend-runtime/kv';
import { digest128 } from '@rexezuge/runtime';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { makeFakeKv } from './mocks/kv';

describe('buildKvKey', () => {
  it('prefixes keys with domain and version', () => {
    expect(buildKvKey('refs', ['foo/bar', 'abc123'])).toBe('refs:v1:foo%2Fbar:abc123');
  });

  it('isolates domains sharing the same parts', () => {
    expect(buildKvKey('jwks', ['x'])).not.toBe(buildKvKey('oauth2', ['x']));
  });

  it('rejects unknown domains, empty parts, and empty segments', () => {
    expect(() => buildKvKey('nope' as never, ['x'])).toThrow(/Unknown KV domain/);
    expect(() => buildKvKey('refs', [])).toThrow(/at least one key part/);
    expect(() => buildKvKey('refs', ['   '])).toThrow(/must not be empty/);
  });

  it('hashes overlong keys deterministically within the length cap', () => {
    const long = `r/${'a'.repeat(600)}`;
    const first = buildKvKey('refs', [long, 'path']);
    const second = buildKvKey('refs', [long, 'path']);
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(KV_MAX_KEY_LENGTH);
    expect(first).toContain(':h:');
  });

  it('digest128 is stable, wide, and 32 hex chars', () => {
    expect(digest128('edge-git')).toBe(digest128('edge-git'));
    expect(digest128('a')).not.toBe(digest128('b'));
    expect(digest128('x')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('clampTtl', () => {
  it('uses the domain default and honors overrides', () => {
    expect(clampTtl(undefined, 'jwks')).toBe(KV_DOMAINS.jwks.ttlSeconds);
    expect(clampTtl(120, 'jwks')).toBe(120);
  });

  it('clamps below the platform minimum and falls back on a non-finite value', () => {
    expect(clampTtl(1, 'ratelimit')).toBe(60);
    expect(clampTtl(Number.NaN, 'jwks')).toBe(KV_DOMAINS.jwks.ttlSeconds);
    expect(clampTtl(Number.POSITIVE_INFINITY, 'jwks')).toBe(KV_DOMAINS.jwks.ttlSeconds);
  });
});

describe('KvCache without a binding', () => {
  it('is unavailable and fail-soft', async () => {
    const cache = createKvCache(null);
    expect(cache.available).toBe(false);
    await expect(cache.getText('refs', ['a'])).resolves.toBeNull();
    await expect(cache.putText('refs', ['a'], 'v')).resolves.toBe(false);
    await expect(cache.getJson('refs', ['a'])).resolves.toBeNull();
    await expect(cache.putJson('refs', ['a'], { v: 1 })).resolves.toBe(false);
    await expect(cache.del('refs', ['a'])).resolves.toBeUndefined();
    await expect(cache.purgePrefix('refs')).resolves.toBe(0);
  });
});

describe('KvCache round-trips', () => {
  it('stores text with the domain TTL and reads it back', async () => {
    const kv = makeFakeKv();
    const cache = createKvCache(kv);
    expect(cache.available).toBe(true);
    await expect(cache.putText('jwks', ['https://team.example.com'], '{"keys":[]}')).resolves.toBe(true);
    await expect(cache.getText('jwks', ['https://team.example.com'])).resolves.toBe('{"keys":[]}');
    expect(kv.seen).toHaveLength(1);
    expect(kv.seen[0].ttl).toBe(KV_DOMAINS.jwks.ttlSeconds);
  });

  it('honors a per-call TTL over the domain default', async () => {
    const kv = makeFakeKv();
    const cache = createKvCache(kv);
    await cache.putText('refs', ['r1', 'oid'], 'snap', { ttlSeconds: 120 });
    expect(kv.seen[0].ttl).toBe(120);
  });

  it('stores raw bytes without base64 inflation', async () => {
    const kv = makeFakeKv();
    const cache = createKvCache(kv);
    const bytes = new Uint8Array([1, 2, 3, 250]);
    await expect(cache.putBytes('readmodel', ['r1', 'pack'], bytes)).resolves.toBe(true);
    // Four bytes in, four bytes stored: the metadata-free binary path, not a
    // base64 envelope.
    expect(kv.seen[0].bytes).toBe(4);
    await expect(cache.getBytes('readmodel', ['r1', 'pack'])).resolves.toEqual(bytes);
  });

  it('rejects oversize values without touching the binding', async () => {
    const kv = makeFakeKv();
    const cache = createKvCache(kv);
    await expect(cache.putText('ratelimit', ['w'], 'x'.repeat(2048))).resolves.toBe(false);
    expect(kv.seen).toHaveLength(0);
  });

  it('round-trips JSON and returns null on corrupt payloads', async () => {
    const kv = makeFakeKv({ 'refs:v1:bad': 'not-json{' });
    const cache = createKvCache(kv);
    await expect(cache.putJson('searchCursor', ['r1'], { next: 8 })).resolves.toBe(true);
    await expect(cache.getJson<{ next: number }>('searchCursor', ['r1'])).resolves.toEqual({ next: 8 });
    await expect(cache.getJson('refs', ['bad'])).resolves.toBeNull();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(cache.putJson('refs', ['c'], circular)).resolves.toBe(false);
  });

  it('deletes single keys', async () => {
    const kv = makeFakeKv();
    const cache = createKvCache(kv);
    await cache.putText('oauth2', ['t1'], 'v');
    await cache.del('oauth2', ['t1']);
    await expect(cache.getText('oauth2', ['t1'])).resolves.toBeNull();
  });

  it('purges by domain prefix without touching sibling domains', async () => {
    const kv = makeFakeKv();
    const cache = createKvCache(kv);
    await cache.putText('refs', ['r1'], 'a');
    await cache.putText('refs', ['r2'], 'b');
    await cache.putText('jwks', ['r1'], 'c');
    await expect(cache.purgePrefix('refs')).resolves.toBe(2);
    await expect(cache.getText('jwks', ['r1'])).resolves.toBe('c');
  });

  it('purges a sub-prefix across list pages', async () => {
    const kv = makeFakeKv();
    const cache = createKvCache(kv);
    const total = 1005;
    for (let i = 0; i < total; i += 1) {
      await cache.putText('refs', [`repo-${i}`], `v${i}`);
    }
    await expect(cache.purgePrefix('refs')).resolves.toBe(total);
    await expect(cache.getText('refs', ['repo-0'])).resolves.toBeNull();
    await expect(cache.getText('refs', [`repo-${total - 1}`])).resolves.toBeNull();
  });
});

describe('KvCache backend failures stay fail-soft', () => {
  it('returns null/false on throwing bindings', async () => {
    const failing: KvNamespaceLike = {
      get: (() => Promise.reject(new Error('boom'))) as unknown as KvNamespaceLike['get'],
      put: () => Promise.reject(new Error('boom')),
      delete: () => Promise.reject(new Error('boom')),
      list: () => Promise.reject(new Error('boom')),
    };
    const cache = createKvCache(failing);
    await expect(cache.getText('refs', ['a'])).resolves.toBeNull();
    await expect(cache.putText('refs', ['a'], 'v')).resolves.toBe(false);
    await expect(cache.del('refs', ['a'])).resolves.toBeUndefined();
    await expect(cache.purgePrefix('refs')).resolves.toBe(0);
  });
});

describe('request-scope KvCache binding', () => {
  it('binds an unavailable cache without CACHE and a live one with it', () => {
    const without = createRequestScope({ DB: {} } as never);
    expect(without.get(Tokens.KvCache).available).toBe(false);
    const kv = makeFakeKv();
    const withBinding = createRequestScope({ DB: {}, CACHE: kv } as never);
    expect(withBinding.get(Tokens.KvCache).available).toBe(true);
    expect(withBinding.get(Tokens.KvCache)).toBe(withBinding.get(Tokens.KvCache));
  });

  it('shares one instance per scope', () => {
    const scope = createRequestScope({ DB: {}, CACHE: makeFakeKv() } as never);
    const seen = vi.fn();
    seen(scope.get(Tokens.KvCache));
    expect(scope.get(Tokens.KvCache)).toBe(scope.get(Tokens.KvCache));
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
