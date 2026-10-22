// Single-KV keyspace: one `CACHE` binding, domains separated by key prefix.
//
// The cache *facade* is the kit's (`@rexezuge/runtime`'s `KvCache`), which brings
// the circuit breaker, the subrequest charge on every issued operation, the
// binary paths, and a 128-bit overflow digest. What stays here is the part the
// kit cannot know: *which* domains this repo caches under, and for how long.
//
// The kit's own table is the default, not a requirement — the TTL and size
// policy is per-repo by definition, so the names below are Edge-Git's.
//
// Rationale: D1 and the Durable Object stay the source of truth. KV is a
// loss-tolerant, read-heavy cache only — a miss or eviction must always be
// recoverable by recompute. Call sites never touch `env.CACHE` directly; they
// go through `KvCache` with a closed `KvDomainName` registry so prefixes
// cannot collide and TTL/size policy lives in one table.

import { buildKvKey as kitBuildKvKey, clampTtl as kitClampTtl } from '@rexezuge/runtime';
import type { KvDomains } from '@rexezuge/runtime';

/**
 * The domains this repo caches under.
 *
 * Closed on purpose: a typo must be a compile error rather than a new
 * keyspace nobody invalidates.
 */
type KvDomainName = 'jwks' | 'oauth2' | 'searchCursor' | 'refs' | 'readmodel' | 'ratelimit';

const KV_DOMAINS: KvDomains<KvDomainName> = {
  jwks: {
    ttlSeconds: 600,
    maxValueBytes: 65_536,
    description: 'Cloudflare Access JWKS cert documents per team domain.',
  },
  oauth2: {
    ttlSeconds: 3600,
    maxValueBytes: 16_384,
    description: 'OAuth token artefacts; per-entry TTL should track expiry.',
  },
  searchCursor: {
    ttlSeconds: 604_800,
    maxValueBytes: 4096,
    description: 'Search backfill cron progress markers per repo.',
  },
  refs: {
    ttlSeconds: 86_400,
    maxValueBytes: 1_048_576,
    description: 'Advertised ref snapshots per repo; invalidated on receive-pack. Long-lived (24h) to keep DO rows_read low.',
  },
  readmodel: {
    ttlSeconds: 86_400,
    maxValueBytes: 1_048_576,
    description: 'Repo read-model snapshots (overview/branches/tags/tree/commits/blob) keyed by head oid; invalidated on push. Long-lived (24h) to keep DO rows_read low.',
  },
  ratelimit: {
    ttlSeconds: 60,
    maxValueBytes: 1024,
    description: 'Rate-limit / idempotency windows. Short-lived by design.',
  },
};

/**
 * The key for a value.
 *
 * The kit's builder, bound to *this* table: a key built against one registry
 * and a TTL resolved against another is a cache that reads and writes under one
 * policy and reports another.
 */
function buildKvKey(domain: KvDomainName, parts: readonly string[]): string {
  return kitBuildKvKey(domain, parts, KV_DOMAINS);
}

/**
 * Resolve a TTL, defaulting to the domain's own.
 */
function clampTtl(ttlSeconds: number | undefined, domain: KvDomainName): number {
  return kitClampTtl(ttlSeconds, domain, KV_DOMAINS);
}

export { KV_DOMAINS, buildKvKey, clampTtl };
export { KV_MAX_KEY_LENGTH, KV_MIN_TTL_SECONDS } from '@rexezuge/runtime';
export type { KvDomainDef, KvDomains } from '@rexezuge/runtime';
export type { KvDomainName };
