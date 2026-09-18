import { BadRequestError } from '@edge-git/backend-errors';
import { PktLine } from './pkt';

const MAX_URL_LENGTH = 2048;
const OID_RE = /^[0-9a-f]{40}$/;
const UPLOAD_PACK_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';
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

interface RemoteRef {
  ref: string;
  oid: string;
}

interface RemotePack {
  refs: RemoteRef[];
  pack: Uint8Array;
}

/**
 * Minimal injected HTTP surface so the client stays testable without
 * network access. Production call sites adapt the global `fetch`.
 */
interface RemoteGitFetcher {
  get(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{ status: number; contentType: string | null; body: Uint8Array }>;
  post(url: string, headers: Record<string, string>, body: Uint8Array, signal: AbortSignal): Promise<{ status: number; body: Uint8Array }>;
}

/**
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

function readPackets(body: Uint8Array): Uint8Array[] {
  const payloads: Uint8Array[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line in remote response');
    const header = PktLine.decodeText(body.slice(offset, offset + 4));
    if ([PktLine.FLUSH, PktLine.DELIM, PktLine.RESPONSE_END].includes(header)) {
      offset += 4;
      continue;
    }
    const length = Number.parseInt(header, 16);
    if (!Number.isSafeInteger(length) || length < 4 || length > PktLine.MAX_PKT_SIZE || offset + length > body.length) {
      throw new Error('invalid pkt-line length in remote response');
    }
    payloads.push(body.slice(offset + 4, offset + length));
    offset += length;
  }
  return payloads;
}

/**
 * Parse a Smart HTTP `info/refs?service=git-upload-pack` advertisement
 * into ref→oid pairs (heads + tags only). Skips the `# service=` header
 * and capability suffixes after NUL.
 */
function parseUploadPackAdvertisement(body: Uint8Array, maxRefs: number): RemoteRef[] {
  const refs: RemoteRef[] = [];
  for (const payload of readPackets(body)) {
    const text = PktLine.decodeText(payload);
    if (text.startsWith('# service=')) continue;
    if (text === 'NAK\n' || text === 'NAK') continue;
    const nul = text.indexOf('\0');
    const line = (nul === -1 ? text : text.slice(0, nul)).trim();
    const match = /^([0-9a-f]{40}) (refs\/\S+)\s*$/.exec(line);
    if (!match) continue;
    const [, oid, ref] = match;
    if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) continue;
    if (refs.some((r) => r.ref === ref)) continue;
    refs.push({ ref, oid });
    if (refs.length > maxRefs) throw new Error(`remote advertises too many refs (limit ${maxRefs})`);
  }
  return refs;
}

/**
 * Build a protocol-v0 `git-upload-pack` request wanting every oid (full
 * history import into an empty repo). First want line carries the
 * capabilities; the request ends with flush + `done`.
 */
function buildUploadPackRequest(wants: string[]): Uint8Array {
  if (wants.length === 0) throw new Error('at least one want is required');
  for (const oid of wants) {
    if (!OID_RE.test(oid)) throw new Error('invalid want oid');
  }
  const caps =
    'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not filter object-format=sha1 agent=edge-git/1.0';
  const lines: Uint8Array[] = [
    PktLine.encode(`want ${wants[0]} ${caps}\n`),
    ...wants.slice(1).map((oid) => PktLine.encode(`want ${oid}\n`)),
    PktLine.encodeFlush(),
    PktLine.encode('done\n'),
  ];
  return PktLine.mergeLines(lines);
}

interface DecodedPack {
  pack: Uint8Array;
}

/**
 * Decode a sideband-64k upload-pack response into raw pack bytes. Progress
 * (band 2) is dropped; remote errors (band 3) throw. A leading `NAK`
 * line is accepted and skipped.
 */
function decodeUploadPackResponse(body: Uint8Array, maxPackBytes: number): DecodedPack {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const payload of readPackets(body)) {
    if (payload.length === 0) continue;
    const channel = payload[0];
    if (channel === PktLine.SIDEBAND_CHANNEL_PACKFILE) {
      const chunk = payload.slice(1);
      total += chunk.length;
      if (total > maxPackBytes) throw new Error(`remote pack too large (limit ${maxPackBytes} bytes)`);
      chunks.push(chunk);
      continue;
    }
    if (channel === PktLine.SIDEBAND_CHANNEL_PROGRESS) continue;
    if (channel === PktLine.SIDEBAND_CHANNEL_ERROR) {
      throw new Error(`remote error: ${PktLine.decodeText(payload.slice(1)).trim().slice(0, 200)}`);
    }
    const text = PktLine.decodeText(payload);
    if (text === 'NAK\n' || text === 'NAK') continue;
    throw new Error('unsupported upload-pack response from remote');
  }
  const pack = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    pack.set(chunk, offset);
    offset += chunk.length;
  }
  if (pack.length < 12 || PktLine.decodeText(pack.slice(0, 4)) !== 'PACK') {
    throw new Error('remote did not return a packfile');
  }
  return { pack };
}

/**
 * Fetch every head/tag pack from a public remote: advertise → want-all →
 * sideband decode. All bounds are enforced before returning.
 */
async function fetchRemotePack(
  fetcher: RemoteGitFetcher,
  sourceUrl: string,
  opts: { maxRefs: number; maxPackBytes: number; timeoutMs: number },
): Promise<RemotePack> {
  const base = normalizePublicGitUrl(sourceUrl);
  const advertiseSignal = AbortSignal.timeout(opts.timeoutMs);
  const advertised = await fetcher.get(
    `${base}/info/refs?service=git-upload-pack`,
    { Accept: 'application/x-git-upload-pack-advertisement' },
    advertiseSignal,
  );
  if (advertised.status !== 200) throw new Error(`remote advertise failed with HTTP ${advertised.status}`);
  if (
    advertised.contentType &&
    !advertised.contentType.includes(UPLOAD_PACK_ADVERTISEMENT) &&
    !advertised.contentType.includes('x-git-upload-pack')
  ) {
    throw new Error('remote is not a git Smart HTTP endpoint');
  }
  const refs = parseUploadPackAdvertisement(advertised.body, opts.maxRefs);
  if (refs.length === 0) throw new Error('remote has no branches or tags to import');
  const packSignal = AbortSignal.timeout(opts.timeoutMs);
  const oids = [...new Set(refs.map((r) => r.oid))];
  const fetched = await fetcher.post(
    `${base}/git-upload-pack`,
    { 'Content-Type': 'application/x-git-upload-pack-request', Accept: 'application/x-git-upload-pack-result' },
    buildUploadPackRequest(oids),
    packSignal,
  );
  if (fetched.status !== 200) throw new Error(`remote upload-pack failed with HTTP ${fetched.status}`);
  const { pack } = decodeUploadPackResponse(fetched.body, opts.maxPackBytes);
  return { refs, pack };
}

export { fetchRemotePack, parseUploadPackAdvertisement, buildUploadPackRequest, decodeUploadPackResponse, normalizePublicGitUrl };
export type { RemoteRef, RemotePack, RemoteGitFetcher };
