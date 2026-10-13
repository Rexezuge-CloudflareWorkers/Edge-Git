/**
 * `@edge-git/shared/utils` — the local utility surface.
 *
 * The kit (`@rexezuge/shared`) owns the platform-generic half: hashing, ids,
 * time, `Result`, the language-tag grammar, secret-safe log redaction and the
 * email rules. Those are re-exported here so the rest of the monorepo still has
 * one import path, and so this file doubles as the record of what Edge-Git
 * deliberately kept.
 *
 * What stays local is git/product business logic the kit documents as its own
 * "left local" list: branch and slug grammars, the `owner/name` identifier and
 * its Durable-Object routing key, git oid shapes, the SSRF host predicates and
 * the concurrency mapper.
 */
export {
  CryptoUtil,
  UUIDUtil,
  TimestampUtil,
  ErrorSanitizationUtil,
  isValidEmailFormat,
  normalizeEmail,
  canonicalizeLanguageTag,
  err,
  getOrThrow,
  isOk,
  mapResult,
  ok,
} from '@rexezuge/shared';
export type { Err, Ok, Result } from '@rexezuge/shared';

export { RepoFullName, OWNER_PATTERN, REPO_PATTERN, repoDoKey, repoDoKeyForFullName } from './Identity';
export { BRANCH_SEGMENT_RE, hasIllegalBranchChar, isValidBranchName } from './BranchValidation';
export { SLUG_RE, isValidSlug, validateSlug } from './SlugValidation';
export { mapWithConcurrency } from './ConcurrencyUtil';
export {
  MAX_URL_LENGTH as MAX_SHARED_URL_LENGTH,
  stripBrackets as stripHostBrackets,
  stripTrailingDot as stripHostTrailingDot,
  isEncodedNumericHost,
  isBlockedIpv6Host,
  isLoopbackHost,
  isLocalhostName,
} from './SsrfHosts';
export { isZeroOid as isZeroGitOid } from './GitOids';