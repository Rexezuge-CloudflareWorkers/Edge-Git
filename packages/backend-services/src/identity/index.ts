import { UserIdentityService as KitUserIdentityService } from '@rexezuge/identity';
import type {  ResolvedAccount, UserIdentityDeps, UserIdentityEnv } from '@rexezuge/identity';
import { UserDAO, UserEmailDAO } from '@edge-git/backend-data/dao';

/**
 * Edge-Git's account layer.
 *
 * The policy — address → `user_emails` → `users.id`, the verified-only
 * registry, the frozen anchor, the fail-closed resolution order, and the
 * address-change ordering — is the kit's `@rexezuge/identity`, converged from
 * the seven repos that authenticate users. What this file supplies is the one
 * thing the kit cannot know: *which* DAOs this repo reads the `users` and
 * `user_emails` tables through.
 *
 * The kit defaults to its own DAOs, which is right for a repo whose schema is
 * the kit's. Edge-Git's `UserDAO` additionally owns the `username` handle and
 * the batch `getByEmails`/`getByIds` the identity presenter needs, so binding
 * them as the defaults here keeps every `new UserIdentityService(env)` call site
 * working unchanged — and leaves the composition root's explicit override as the
 * single place a fake is injected.
 */
class UserIdentityService extends KitUserIdentityService {
  constructor(env: UserIdentityEnv, deps: UserIdentityDeps = {}) {
    super(env, {
      userDAO: () => Promise.resolve(new UserDAO(env.DB)),
      userEmailDAO: () => Promise.resolve(new UserEmailDAO(env.DB)),
      ...deps,
    });
  }
}

/**
The resolved account shape, under the name this repo has always used.
*/
type AccountIdentity = ResolvedAccount;

export { UserIdentityService };
export { IdentityResolver, GHOST_USERNAME } from './IdentityResolver';
export type { IdentityResolverDeps, IdentityResolverEnv } from './IdentityResolver';
export type { AccountIdentity,     };

export {type AccountLookupDeps, type UserIdentityDeps, type UserIdentityEnv, type ResolvedAccount} from '@rexezuge/identity';