import type { Context, Next } from 'hono';
import { rateLimit as kitRateLimit } from '@rexezuge/http';
import type { RateLimitOptions } from '@rexezuge/http';

type RateLimitContext = Context<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

/**
 * The rate limiter is the kit's (`@rexezuge/http`'s `rateLimit`), converged from
 * the four repos that shipped a copy — including the two fixes Edge-Git's had
 * (the per-request bucket sweep, and `Retry-After` on the 429) and one it did
 * not: a throttle that answers in the same `{Exception:{Type,Message}}` dialect
 * every other error on this worker uses, so a client that parses that envelope
 * does not read a 429 as a server fault and retry straight back into it.
 *
 * The kit also scopes its bucket map to the *limiter instance* rather than to
 * the module. Two consequences worth stating, because the old module-scoped map
 * hid both:
 *
 * - Limiters installed with different `keyPrefix`es cannot collide, and a test
 *   that builds a fresh `EdgeGitWorker` gets fresh buckets with no reset seam
 *   to remember — which is why there is no `resetRateLimitForTests` here any
 *   more.
 * - The bucket state lives as long as the route registration, which is as long
 *   as the isolate. Nothing leaks between requests that share a limiter, and
 *   nothing leaks between limiters.
 *
 * IP grouping stays fail-closed: without a trusted `CF-Connecting-IP` all
 * callers share the `unknown` bucket rather than getting per-spoofed-header
 * isolation. `X-Forwarded-For` is not trusted because it is client-controlled.
 */
const rateLimit = kitRateLimit as unknown as (
  opts: RateLimitOptions,
) => (c: RateLimitContext, next: Next) => Promise<Response | void>;

export { rateLimit };
export type { RateLimitContext };