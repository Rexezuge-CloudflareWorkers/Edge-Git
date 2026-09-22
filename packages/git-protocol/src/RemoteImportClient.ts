import { PktLine } from './pkt';
import { normalizePublicGitUrl } from './GitUrlPolicy';

export { normalizePublicGitUrl, resolveRedirectUrl, MAX_REDIRECTS } from './GitUrlPolicy';

const OID_RE = /^[0-9a-f]{40}$/;
const UPLOAD_PACK_ADVERTISEMENT = 'application/x-git-upload-pack-advertisement';

interface RemoteRef {
  ref: string;
  oid: string;
}

interface RemotePack {
  refs: RemoteRef[];
  pack: Uint8Array;
  // Advertised `HEAD` symref target (e.g. `refs/heads/main`), if present.
  symbolicHead: string | null;
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
 * into ref→oid pairs (heads + tags only) plus the advertised `HEAD` symref
 * target, if any. Skips the `# service=` header and capability suffixes
 * after NUL. The symref lets import/mirror preserve the upstream default
 * branch instead of leaving HEAD dangling at the fresh-repo `main`.
 */
function parseUploadPackAdvertisement(body: Uint8Array, maxRefs: number): { refs: RemoteRef[]; symbolicHead: string | null } {
  const refs: RemoteRef[] = [];
  let symbolicHead: string | null = null;
  for (const payload of readPackets(body)) {
    const text = PktLine.decodeText(payload);
    if (text.startsWith('# service=')) continue;
    if (text === 'NAK\n' || text === 'NAK') continue;
    const nul = text.indexOf('\0');
    const line = (nul === -1 ? text : text.slice(0, nul)).trim();
    if (nul !== -1 && symbolicHead === null && /^[0-9a-f]{40} HEAD\s*$/.test(line)) {
      const symref = /symref=HEAD:(refs\/heads\/\S+)/.exec(text.slice(nul + 1));
      if (symref) symbolicHead = symref[1];
    }
    const match = /^([0-9a-f]{40}) (refs\/\S+)\s*$/.exec(line);
    if (!match) continue;
    const [, oid, ref] = match;
    if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) continue;
    if (refs.some((r) => r.ref === ref)) continue;
    refs.push({ ref, oid });
    if (refs.length > maxRefs) throw new Error(`remote advertises too many refs (limit ${maxRefs})`);
  }
  return { refs, symbolicHead };
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
  const { refs, symbolicHead } = parseUploadPackAdvertisement(advertised.body, opts.maxRefs);
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
  return { refs, pack, symbolicHead };
}

export { fetchRemotePack, parseUploadPackAdvertisement, buildUploadPackRequest, decodeUploadPackResponse };
export type { RemoteRef, RemotePack, RemoteGitFetcher };
