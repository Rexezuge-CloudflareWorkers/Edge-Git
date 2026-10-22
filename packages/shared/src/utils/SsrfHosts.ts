/**
 * Canonical SSRF host helpers (Layer 0).
 *
 * Why this exists: `GitUrlPolicy` (git imports, https-only) and webhook URL
 * validation previously duplicated bracket/dot stripping, encoded-numeric
 * detection, and IPv6 blocklists. A fix in one copy missed the other, so both
 * now delegate here. Policy differences (allowed schemes, IPv4 handling)
 * stay with the callers — only the shared host predicates live here.
 *
 * What the kit already owns is the kit's: the bracket and trailing-dot
 * strippers and the localhost-name rule are the *same* rules the kit's
 * `RemoteUrlPolicy` answers with, so they are re-exported from there rather
 * than kept as a second copy that can drift from the one the kit's own
 * composite predicate uses. What stays local is the pair the kit does not
 * export on its own — the raw encoded-numeric and IPv6 blocklist predicates —
 * because the callers here distinguish them in their error messages.
 */

import { isLocalhostName as kitIsLocalhostName, stripBrackets as kitStripBrackets, stripTrailingDot as kitStripTrailingDot } from '@rexezuge/shared';
import { MAX_REMOTE_URL_LENGTH } from '@rexezuge/shared';

const MAX_URL_LENGTH = MAX_REMOTE_URL_LENGTH;

function stripBrackets(host: string): string {
  return kitStripBrackets(host);
}

function stripTrailingDot(host: string): string {
  return kitStripTrailingDot(host);
}

function isEncodedNumericHost(host: string): boolean {
  const h = host.toLowerCase();
  if (/^0x[\da-f]+$/i.test(h)) return true;
  if (/^\d+$/.test(h)) return true;
  if (/^0[0-7]+(?:\.0[0-7]+)+$/.test(h)) return true;
  if (/^0x[\da-f.]+$/i.test(h)) return true;
  if (/^[\d.]+$/i.test(h) && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

function isBlockedIpv6Host(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return true;
  if (h.startsWith('::ffff:')) return true;
  if (/^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(h)) return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  if (/^fe[89ab]/i.test(h)) return true;
  if (h.startsWith('ff')) return true;
  if (/^fe80:/i.test(h)) return true;
  return false;
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === '::1' || h === '0.0.0.0' || h === '::' || h.startsWith('::ffff:127.');
}

/**
 * Whether a host name means "this machine or a local suffix".
 *
 * The rule is the kit's, and it is the same rule the kit's own
 * `isPrivateOrInternalHost` answers with — one predicate for one decision,
 * not two that drift.
 *
 * The case is normalized here because DNS is case-insensitive and the
 * published kit compares against a lowercase set: `LOCALHOST` names the same
 * host as `localhost` and resolves to loopback. The kit's own fix for this is
 * unreleased at the version this repo pins, so the normalization stays here
 * and becomes a no-op once that release lands.
 */
function isLocalhostName(host: string): boolean {
  return kitIsLocalhostName(host.toLowerCase());
}

export {
  MAX_URL_LENGTH,
  stripBrackets,
  stripTrailingDot,
  isEncodedNumericHost,
  isBlockedIpv6Host,
  isLoopbackHost,
  isLocalhostName,
};
