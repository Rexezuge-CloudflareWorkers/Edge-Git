import type { KvNamespaceLike } from '@edge-git/backend-runtime/kv';

/**
 * An in-memory stand-in for the single `CACHE` KV binding.
 *
 * Faithful to the platform in the two places the kit's cache depends on:
 * `get` defaults to **text** (the kit states the type it wants rather than
 * relying on the default, and a double that always answered bytes would hide
 * that), and `put` accepts raw bytes as well as text.
 */
export interface FakeKvNamespace extends KvNamespaceLike {
  /** Every entry, keyed as the platform keys it. */
  store: Map<string, string | ArrayBuffer>;
  /** Every write, in order, with the TTL it was given. */
  seen: Array<{ key: string; ttl?: number; bytes: number }>;
}

function makeFakeKv(initial: Record<string, string> = {}): FakeKvNamespace {
  const store = new Map<string, string | ArrayBuffer>(Object.entries(initial));
  const seen: FakeKvNamespace['seen'] = [];

  function get(key: string): Promise<string | null>;
  function get(key: string, type: 'text'): Promise<string | null>;
  function get(key: string, type: 'arrayBuffer'): Promise<ArrayBuffer | null>;
  function get(key: string, type?: 'text' | 'arrayBuffer'): Promise<string | ArrayBuffer | null> {
    const value = store.get(key);
    if (value === undefined) return Promise.resolve(null);
    if (type === 'arrayBuffer') {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
      // A copy, so a caller cannot mutate what the store holds.
      return Promise.resolve(bytes.slice().buffer);
    }
    return Promise.resolve(typeof value === 'string' ? value : new TextDecoder().decode(value));
  }

  return {
    store,
    seen,
    get,
    put(key: string, value: string | ArrayBuffer, options?: { expirationTtl?: number }): Promise<void> {
      seen.push({
        key,
        ttl: options?.expirationTtl,
        bytes: typeof value === 'string' ? new TextEncoder().encode(value).byteLength : value.byteLength,
      });
      store.set(key, typeof value === 'string' ? value : value.slice(0));
      return Promise.resolve();
    },
    delete(key: string): Promise<boolean> {
      return Promise.resolve(store.delete(key));
    },
    list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }> {
      const names = [...store.keys()].filter((name) => name.startsWith(options.prefix)).sort();
      const start = options.cursor ? Number(options.cursor) : 0;
      const limit = options.limit ?? 1000;
      const page = names.slice(start, start + limit);
      const next = start + limit;
      return Promise.resolve({
        keys: page.map((name) => ({ name })),
        list_complete: next >= names.length,
        cursor: next >= names.length ? undefined : String(next),
      });
    },
  };
}

export { makeFakeKv };
