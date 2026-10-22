export { UserDAO, loginEmailOf } from './UserDAO';
export type { UserRow } from './UserDAO';
// The address registry's DAO is the kit's (`@rexezuge/identity`), not a local
// copy: its `register` carries the `WHERE user_emails.is_verified = 0`
// guard, without which a claim that loses a race re-points a row that is
// verified *now* — an account takeover rather than a failed claim. Re-exported
// from the same path so every call site is unchanged.
export { UserEmailDAO } from '@rexezuge/identity';
export type { UserEmailRow } from '@rexezuge/identity';
export { UserAccessTokenDAO } from './UserAccessTokenDAO';
export type { TokenRow } from './UserAccessTokenDAO';
export { TokenRepoGrantDAO } from './TokenRepoGrantDAO';
export { NamespaceDAO } from './NamespaceDAO';
export type { NamespaceRow, NamespaceKind } from './NamespaceDAO';
