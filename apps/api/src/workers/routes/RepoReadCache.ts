import type { KvCache } from '@edge-git/backend-runtime/kv';
import { fnv1aHex } from '@edge-git/backend-runtime/kv';
import { repoDoKeyForFullName } from '@edge-git/shared/utils';

// KV-backed read-model cache for repo RPCs (Otter pure-helper + facade).
// D1/DO stay authoritative; KV is loss-tolerant. All keys use the canonical
// lowercase DO key so `Foo/Bar` and `foo/bar` share one cache entry, matching
// `REPO.getByName` sharding. Refs snapshots live 24h (`refs` domain) and are
// invalidated on push; read-model snapshots live 24h (`readmodel` domain)
// keyed by head oid so branch-tip moves naturally miss.

type RefsSnapshot = { refs: Array<{ ref: string; oid: string }>; symbolicHead: string | null };

const REFS_TTL_SECONDS = 86_400;
const READMODEL_TTL_SECONDS = 86_400;
// Tight fetch-loop guard: identical `git fetch` bodies (IDE auto-fetch,
// broken cron) each burn a full DO pack walk. Only 2 identical fetches per
// 5min window pass; the 3rd gets 429 + Retry-After instead of more rows.
const FETCH_LOOP_WINDOW_SECONDS = 300;
const FETCH_LOOP_MAX_REPEATS = 2;
// Upper bound for KV-cached fetch responses (raw bytes). `readmodel` caps at
// 1MiB; base64 inflates ~33%, so only small/negotiation responses are cached.
// Full clones bypass the cache and always hit the DO.
const MAX_CACHED_PACK_BYTES = 700_000;

function cacheKeyForRepo(fullName: string): string {
  return repoDoKeyForFullName(fullName);
}

function headOidFromRefs(snapshot: RefsSnapshot | null): string | null {
  if (!snapshot) return null;
  const head = snapshot.refs.find((r) => r.ref === 'HEAD');
  return head?.oid ?? snapshot.refs[0]?.oid ?? null;
}

function etagForRefs(snapshot: RefsSnapshot | null): string | null {
  const head = headOidFromRefs(snapshot);
  return head ? `W/"refs-${head.slice(0, 16)}"` : null;
}

function etagForReadModel(headOid: string, kind: string, argsKey: string): string {
  const base = headOid === 'empty' ? 'empty' : headOid.slice(0, 16);
  return `W/"${kind}-${base}-${fnv1aHex(argsKey)}"`;
}

function argsKeyFor(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function isFresh(request: Request, etag: string | null): boolean {
  if (!etag) return false;
  const incoming = request.headers.get('If-None-Match');
  if (!incoming) return false;
  return incoming.split(',').some((part) => part.trim() === etag || part.trim() === '*');
}

function cacheControlFor(kind: string, immutable = false): string {
  if (immutable) return 'private, max-age=86400, immutable';
  if (['overview', 'branches', 'tags'].includes(kind)) return 'private, max-age=30, must-revalidate';
  return 'private, max-age=10, must-revalidate';
}

function withEtagHeaders(response: Response, etag: string, cacheControl: string): Response {
  const headers = new Headers(response.headers);
  headers.set('ETag', etag);
  headers.set('Cache-Control', cacheControl);
  return new Response(response.body, { status: response.status, headers });
}

function jsonWithEtag(
  c: { json: (data: unknown, status?: number, headers?: Record<string, string>) => Response },
  data: unknown,
  etag: string,
  cacheControl: string,
): Response {
  return c.json(data, 200, { ETag: etag, 'Cache-Control': cacheControl });
}

async function getCachedRefs(cache: KvCache, fullName: string): Promise<RefsSnapshot | null> {
  return cache.getJson<RefsSnapshot>('refs', [cacheKeyForRepo(fullName), 'snapshot']);
}

async function putCachedRefs(cache: KvCache, fullName: string, snapshot: RefsSnapshot): Promise<void> {
  await cache.putJson('refs', [cacheKeyForRepo(fullName), 'snapshot'], snapshot, { ttlSeconds: REFS_TTL_SECONDS });
}

async function getCachedReadModel<T>(
  cache: KvCache,
  fullName: string,
  kind: string,
  argsKey: string,
  headOid = 'empty',
): Promise<T | null> {
  return cache.getJson<T>('readmodel', [cacheKeyForRepo(fullName), kind, headOid.slice(0, 16), fnv1aHex(argsKey)]);
}

async function putCachedReadModel(
  cache: KvCache,
  fullName: string,
  kind: string,
  argsKey: string,
  headOid: string,
  value: unknown,
): Promise<void> {
  await cache.putJson('readmodel', [cacheKeyForRepo(fullName), kind, headOid.slice(0, 16), fnv1aHex(argsKey)], value, {
    ttlSeconds: READMODEL_TTL_SECONDS,
  });
}

async function invalidateRepoCaches(cache: KvCache, fullName: string): Promise<void> {
  const key = cacheKeyForRepo(fullName);
  await cache.del('refs', [key, 'snapshot']);
  // Purges read-model snapshots and cached fetch responses (both live in the
  // `readmodel` domain under this repo prefix) so post-push reads refetch.
  await cache.purgePrefix('readmodel', [key]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = (binary.codePointAt(i) ?? 0) & 0xff;
  return out;
}

// Small fetch-response cache for identical `git fetch` polls between pushes.
// Keyed by (headOid, bodyHash): pushes invalidate via `invalidateRepoCaches`
// (refs snapshot miss => new head => miss), so stale packs are impossible.
// Only responses under MAX_CACHED_PACK_BYTES are stored; full clones bypass.
// Fail-soft like the rest of this module: misses recompute from the DO.
async function getCachedPack(cache: KvCache, fullName: string, headOid: string, bodyHash: string): Promise<Uint8Array | null> {
  try {
    const entry = await cache.getJson<{ b64: string }>('readmodel', [cacheKeyForRepo(fullName), 'pack', headOid.slice(0, 16), bodyHash]);
    if (!entry?.b64) return null;
    return base64ToBytes(entry.b64);
  } catch {
    return null;
  }
}

async function putCachedPack(cache: KvCache, fullName: string, headOid: string, bodyHash: string, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > MAX_CACHED_PACK_BYTES) return;
  try {
    await cache.putJson(
      'readmodel',
      [cacheKeyForRepo(fullName), 'pack', headOid.slice(0, 16), bodyHash],
      { b64: bytesToBase64(bytes) },
      {
        ttlSeconds: READMODEL_TTL_SECONDS,
      },
    );
  } catch {
    // Best-effort cache population.
  }
}

// Streaming FNV-1a over the full request body. Previously only the first
// 512 bytes were hashed, so distinct fetches with a shared prefix collided
// into one bucket (false 429s) while distinct suffixes evaded the guard.
// Iterating bytes directly avoids building a 1MB string for hashing.
function hashFetchBody(body: Uint8Array): string {
  let hash = 0x81_1c_9d_c5;
  for (const byte of body) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return `${body.byteLength}:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

// Tight `git fetch` loops (IDE auto-fetch, broken cron) send identical bodies
// every few seconds and each burns thousands of DO rows. Deduplicate by body
// hash + caller identity in the `ratelimit` domain; the 3rd identical fetch
// inside 5min gets 429 + Retry-After instead of another pack walk.
async function checkFetchLoop(
  cache: KvCache,
  fullName: string,
  identity: string,
  body: Uint8Array,
): Promise<{ allowed: true } | { allowed: false; retryAfter: number }> {
  const hash = hashFetchBody(body);
  const key = [cacheKeyForRepo(fullName), identity, hash];
  const now = Date.now();
  const seen = await cache.getJson<{ count: number; startedAt: number }>('ratelimit', key);
  if (!seen) {
    await cache.putJson('ratelimit', key, { count: 1, startedAt: now }, { ttlSeconds: FETCH_LOOP_WINDOW_SECONDS });
    return { allowed: true };
  }
  if (now - seen.startedAt > FETCH_LOOP_WINDOW_SECONDS * 1000) {
    await cache.putJson('ratelimit', key, { count: 1, startedAt: now }, { ttlSeconds: FETCH_LOOP_WINDOW_SECONDS });
    return { allowed: true };
  }
  if (seen.count >= FETCH_LOOP_MAX_REPEATS) {
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((seen.startedAt + FETCH_LOOP_WINDOW_SECONDS * 1000 - now) / 1000)) };
  }
  await cache.putJson('ratelimit', key, { count: seen.count + 1, startedAt: seen.startedAt }, { ttlSeconds: FETCH_LOOP_WINDOW_SECONDS });
  return { allowed: true };
}

interface ReadModelContext {
  readonly req: { readonly raw: Request };
  json(data: unknown, status?: number, headers?: Record<string, string>): Response;
}

// Shared conditional-GET + KV wrapper for mutable read-model RPCs.
// Flow is fail-soft: any KV error falls through to the DO loader so caching
// can never break reads. On refs miss the caller-supplied `fetchRefs` warms
// the snapshot (one cheap `listRefs`) so later polls can 304 without DO I/O.
async function serveReadModel<T>(
  c: ReadModelContext,
  cache: KvCache,
  fullName: string,
  kind: string,
  args: unknown,
  load: () => Promise<T>,
  options?: { fetchRefs?: () => Promise<RefsSnapshot>; extractHeadOid?: (result: T) => string | null },
): Promise<Response> {
  const argsKey = argsKeyFor(args);
  let snapshot: RefsSnapshot | null = null;
  try {
    snapshot = await getCachedRefs(cache, fullName);
  } catch {
    snapshot = null;
  }
  if (!snapshot && options?.fetchRefs) {
    try {
      snapshot = await options.fetchRefs();
      await putCachedRefs(cache, fullName, snapshot);
    } catch {
      snapshot = null;
    }
  }
  const headOid = headOidFromRefs(snapshot);
  // When refs are still missing (DO error), fall back to the result-derived
  // head when available so the payload is still cacheable by content.
  const etagFromRefs = headOid ? etagForReadModel(headOid, kind, argsKey) : null;
  if (etagFromRefs && isFresh(c.req.raw, etagFromRefs)) {
    return new Response(null, { status: 304, headers: { ETag: etagFromRefs } });
  }
  if (headOid) {
    try {
      const cached = await getCachedReadModel<T>(cache, fullName, kind, argsKey, headOid);
      if (cached !== null) return jsonWithEtag(c, cached, etagFromRefs as string, cacheControlFor(kind));
    } catch {
      // Fall through to the DO loader.
    }
  }
  const result = await load();
  const resolvedHead = headOid ?? options?.extractHeadOid?.(result) ?? 'empty';
  const etag = etagForReadModel(resolvedHead, kind, argsKey);
  if (isFresh(c.req.raw, etag)) return new Response(null, { status: 304, headers: { ETag: etag } });
  try {
    await putCachedReadModel(cache, fullName, kind, argsKey, resolvedHead, result);
  } catch {
    // Best-effort cache population.
  }
  return jsonWithEtag(c, result, etag, cacheControlFor(kind));
}

// Immutable oid-addressed reads (commit diffs by oid) never need refs: the
// oid itself is the ETag and the KV key, cached for 24h.
async function serveImmutableReadModel<T>(
  c: ReadModelContext,
  cache: KvCache,
  fullName: string,
  kind: string,
  oid: string,
  load: () => Promise<T | null>,
): Promise<Response | null> {
  const etag = `W/"${kind}-${oid.slice(0, 16)}"`;
  if (isFresh(c.req.raw, etag)) return new Response(null, { status: 304, headers: { ETag: etag } });
  try {
    const cached = await cache.getJson<T>('readmodel', [cacheKeyForRepo(fullName), kind, oid.toLowerCase()]);
    if (cached !== null) return jsonWithEtag(c, cached, etag, cacheControlFor(kind, true));
  } catch {
    // Fall through to the DO loader.
  }
  const result = await load();
  if (!result) return null;
  try {
    await cache.putJson('readmodel', [cacheKeyForRepo(fullName), kind, oid.toLowerCase()], result, { ttlSeconds: REFS_TTL_SECONDS });
  } catch {
    // Best-effort.
  }
  return jsonWithEtag(c, result, etag, cacheControlFor(kind, true));
}

export {
  REFS_TTL_SECONDS,
  READMODEL_TTL_SECONDS,
  FETCH_LOOP_WINDOW_SECONDS,
  FETCH_LOOP_MAX_REPEATS,
  MAX_CACHED_PACK_BYTES,
  cacheKeyForRepo,
  headOidFromRefs,
  etagForRefs,
  etagForReadModel,
  argsKeyFor,
  isFresh,
  cacheControlFor,
  withEtagHeaders,
  jsonWithEtag,
  getCachedRefs,
  putCachedRefs,
  getCachedReadModel,
  putCachedReadModel,
  invalidateRepoCaches,
  checkFetchLoop,
  hashFetchBody,
  getCachedPack,
  putCachedPack,
  serveReadModel,
  serveImmutableReadModel,
};
export type { RefsSnapshot, ReadModelContext };
