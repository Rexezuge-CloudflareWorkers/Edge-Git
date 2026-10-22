// `KvCache` — the kit's (`@rexezuge/runtime`), over Edge-Git's domain table.
//
// The facade itself is not a local copy: the kit's brings the circuit breaker
// (a namespace that is *hanging* rather than erroring still costs every read a
// timeout), the subrequest charge on every issued operation, the binary paths,
// and a 128-bit overflow digest. What stays here is the vocabulary — which
// domains this repo caches under, and for how long — in `KvDomains.ts`.
export { createKvCache } from './KvCache';
export type { KvCache } from './KvCache';
export type { KvNamespaceLike, KvPutOptions } from '@rexezuge/runtime';
export { KV_DOMAINS, buildKvKey, clampTtl, KV_MAX_KEY_LENGTH, KV_MIN_TTL_SECONDS } from './KvDomains';
export type { KvDomainDef, KvDomainName, KvDomains } from './KvDomains';
