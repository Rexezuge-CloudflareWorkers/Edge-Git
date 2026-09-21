/**
 * Canonical org/team slug validation (Layer 0).
 *
 * Consolidates the identical `ORG_NAME_RE` (`OrganizationService`) and
 * `TEAM_SLUG_RE` (`TeamService`) regexes into one module so user/org/team
 * namespaces share a single namespace rule.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;

function isValidSlug(value: string): boolean {
  return SLUG_RE.test(value);
}

function validateSlug(value: string): void {
  if (!isValidSlug(value)) {
    throw new Error('Invalid slug: must be 1-39 chars, alphanumeric with interior hyphens');
  }
}

export { SLUG_RE, isValidSlug, validateSlug };
