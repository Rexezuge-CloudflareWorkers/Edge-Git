import { BadRequestError } from '@edge-git/backend-errors';

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 3;
const LOOPBACK_HOSTS = new Set(['::1', '0.0.0.0', '::']);

function stripBrackets(host: string): string {
  const h = host.trim();
  if (h.startsWith('[') && h.endsWith(']')) return h.slice(1, -1);
  return h;
}

function stripTrailingDot(host: string): string {
  const unbracketed = stripBrackets(host);
  let end = unbracketed.length;
  while (end > 0 && unbracketed.charAt(end - 1) === '.') end -= 1;
  return unbracketed.slice(0, end);
}

function isEncodedNumericHost(host: string): boolean {
  const h = host.toLowerCase();
  if (/^0x[\da-f]+$/i.test(h)) return true;
  if (/^\d+$/.test(h)) return true;
  if (/^0[0-7]+(?:\.0[0-7]+)+$/.test(h)) return true;
  if (/^0x[\da-f.]+$/i.test(h)) return true;
  if (/^[\d.]+$/.test(h) && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

function isBlockedIpv6Host(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::') return true;
  if (h.startsWith('::ffff:')) return true;
  if (/^::ffff:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(h)) return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;
  if (/^fe[89ab]/i.test(h)) return true;
  if (h.startsWith('ff')) return true;
  return false;
}

/**
 * Public-git URL policy (Policy pattern), extracted from
 * `RemoteImportClient` (SRP).
 *
 * Normalize a user-supplied public git URL. v1 only supports public
 * `https` remotes: credentials are rejected and private/loopback hosts are
 * refused (same SSRF posture as webhook URLs, plus https-only since git
 * passwords must never travel in import URLs).
 */
function normalizePublicGitUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new BadRequestError('sourceUrl is required');
  const url = raw.trim();
  if (url.length > MAX_URL_LENGTH) throw new BadRequestError(`sourceUrl must be at most ${MAX_URL_LENGTH} characters`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestError('sourceUrl must be a valid absolute URL');
  }
  if (parsed.protocol !== 'https:') throw new BadRequestError('sourceUrl must use https');
  if (parsed.username || parsed.password) throw new BadRequestError('sourceUrl must not embed credentials');
  const rawHost = parsed.hostname.toLowerCase();
  const host = stripTrailingDot(rawHost);
  if (host === '' || host.includes('%') || host.includes('_')) throw new BadRequestError('sourceUrl must target a valid hostname');
  if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.localhost')) {
    throw new BadRequestError('sourceUrl must not target localhost');
  }
  if (isBlockedIpv6Host(host)) throw new BadRequestError('sourceUrl must not target a private or reserved address');
  if (isEncodedNumericHost(host)) throw new BadRequestError('sourceUrl must not target a private or reserved address');
  if (LOOPBACK_HOSTS.has(host) || host.startsWith('::ffff:127.')) {
    throw new BadRequestError('sourceUrl must not target a loopback address');
  }
  const octets = host.split('.');
  if (octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const [a, b] = [Number(octets[0]), Number(octets[1])];
    const loopback = a === 127;
    const rfc1918 = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    const linkLocal = a === 169 && b === 254;
    const carrierGrade = a === 100 && b >= 64 && b <= 127;
    if (loopback || rfc1918 || linkLocal || carrierGrade || a === 0) {
      throw new BadRequestError('sourceUrl must not target a private or reserved address');
    }
  }
  // Strip query/fragment/trailing slashes; keep an explicit `.git` suffix.
  parsed.search = '';
  parsed.hash = '';
  let path = parsed.pathname;
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/' || path.length === 0) throw new BadRequestError('sourceUrl must include a repository path');
  parsed.pathname = path;
  let href = parsed.href;
  while (href.length > 1 && href.endsWith('/')) href = href.slice(0, -1);
  return href;
}

/**
 * Resolve + re-validate a redirect target against the original base. Every
 * hop must pass the same SSRF guard (`normalizePublicGitUrl`); callers using
 * manual-redirect fetch must loop with this (max MAX_REDIRECTS). DNS-rebind
 * between validation and connect is NOT covered (no resolver in Workers) —
 * documented, mitigated by https-only + short timeouts.
 */
function resolveRedirectUrl(base: string, location: string): string {
  if (typeof location !== 'string' || location.trim().length === 0) {
    throw new BadRequestError('remote returned an empty redirect');
  }
  let next: string;
  try {
    next = new URL(location, base).href;
  } catch {
    throw new BadRequestError('remote returned an invalid redirect');
  }
  return normalizePublicGitUrl(next);
}

export { normalizePublicGitUrl, resolveRedirectUrl, MAX_URL_LENGTH, MAX_REDIRECTS, isEncodedNumericHost, isBlockedIpv6Host };
