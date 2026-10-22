// `KvCache` — the kit's (`@rexezuge/runtime`), bound to Edge-Git's keyspace.
//
// The facade itself is not a local copy: the kit's brings the circuit breaker
// (a namespace that is *hanging* rather than erroring still costs every read a
// timeout), the subrequest charge on every issued operation, the binary paths,
// and a 128-bit overflow digest.
//
// What stays here is the vocabulary — which domains this repo caches under, and
// for how long — in `KvDomains.ts`, and the binding of the two. The kit takes
// the registry as a constructor argument because the TTL and size policy is
// per-repo by definition; here it is not optional, because it is *this* repo's
// keyspace and every caller means it. A cache built against the kit's default
// table would answer for `session`/`asset`/`metadata` and throw on `refs`.
import { KvCache as KitKvCache } from '@rexezuge/runtime';
import type { KvNamespaceLike, SubrequestMeterLike } from '@rexezuge/runtime';
import { KV_DOMAINS } from './KvDomains';
import type { KvDomainName } from './KvDomains';

/**
 * The cache, closed over Edge-Git's domains.
 */
type KvCache = KitKvCache<KvDomainName>;

/**
 * The cache over the single `CACHE` KV binding.
 *
 * @param namespace The binding, or `null` for a deployment without one.
 * @param meter The invocation's subrequest counter, or an unmetered default.
 */
function createKvCache(namespace?: KvNamespaceLike | null, meter?: SubrequestMeterLike): KvCache {
  return new KitKvCache<KvDomainName>(namespace, meter, KV_DOMAINS);
}

export { createKvCache };
export type { KvCache };
