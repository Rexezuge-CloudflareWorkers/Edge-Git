import type { Context, Next } from 'hono';
import {
  applySecurityHeaders as kitApplySecurityHeaders,
  securityHeaders as kitSecurityHeaders,
  
} from '@rexezuge/http';

type HeaderContext = Context<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

/**
 * Baseline security headers for API JSON responses and the SPA shell.
 *
 * The header table and the CSP/HSTS rules are the kit's (`@rexezuge/http`),
 * converged from four byte-identical copies. The SPA ships inline scripts and
 * styles from the Vite build, so CSP allows `'unsafe-inline'` for both, bounded
 * by same-origin and `frame-ancestors 'none'`; hashes or nonces are a future
 * tightening once the build emits stable hashes.
 */
const applySecurityHeaders = (c: HeaderContext): void => kitApplySecurityHeaders(c, isSensitiveJsonPath);

/**
 * Paths carrying bearer secrets or private user data — never cache.
 *
 * All `/user/*` JSON is `no-store` by default (collaborators, orgs,
 * notifications, stars/watches, search reflecting private titles). Public
 * `/repos/*` stays cacheable except issues/pulls/audit reflections.
 *
 * The kit takes this predicate as a *required* argument rather than defaulting
 * it, and that is the point: a default that answered `false` everywhere would
 * be a no-store that looks like protection.
 */
function isSensitiveJsonPath(pathname: string): boolean {
  if (['/user/tokens', '/user/realtime/ticket', '/user/realtime/inbox-ticket'].includes(pathname)) {
    return true;
  }
  if (pathname.startsWith('/user/')) return true;
  return pathname.includes('/issues') || pathname.includes('/pulls') || pathname.includes('/audit');
}

const securityHeaders = kitSecurityHeaders as unknown as (
  isSensitive: (pathname: string) => boolean,
) => (c: HeaderContext, next: Next) => Promise<Response | void>;

export { securityHeaders,  isSensitiveJsonPath, applySecurityHeaders };
export type { HeaderContext };
export {SECURITY_HEADERS} from '@rexezuge/http';