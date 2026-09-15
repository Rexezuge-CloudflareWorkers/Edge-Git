import { PktLine } from './pkt';
import type { RefUpdateResult } from './types';

export interface AdvertiseRefs {
  refs: Array<{ ref: string; oid: string }>;
  symbolicHead: string | null;
}

export function advertiseUploadPack(): Response {
  const lines = [
    PktLine.encode('version 2\n'),
    PktLine.encode('agent=edge-git/0.1.0\n'),
    PktLine.encode('ls-refs\n'),
    PktLine.encode('fetch=wait-for-done shallow filter\n'),
    PktLine.encode('side-band-64k\n'),
    PktLine.encode('object-format=sha1\n'),
    PktLine.encodeFlush(),
  ];

  const response = PktLine.decodeText(PktLine.mergeLines(lines));
  return new Response(response, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-git-upload-pack-advertisement',
      'Cache-Control': 'no-cache',
    },
  });
}

export async function advertiseReceivePack(listRefs: () => Promise<AdvertiseRefs>): Promise<Response> {
  const capabilities = ['report-status', 'delete-refs', 'atomic', 'no-thin', 'agent=edge-git/0.1.0'];

  const { refs, symbolicHead } = await listRefs();

  if (symbolicHead) {
    capabilities.push(`symref=HEAD:${symbolicHead}`);
  }

  const capabilitiesStr = capabilities.join(' ');

  const lines = [PktLine.encode('# service=git-receive-pack\n'), PktLine.encodeFlush()];

  if (refs.length > 0) {
    const first = refs[0];
    lines.push(PktLine.encode(`${first.oid} ${first.ref}\0${capabilitiesStr}\n`));
    for (let i = 1; i < refs.length; i += 1) {
      lines.push(PktLine.encode(`${refs[i].oid} ${refs[i].ref}\n`));
    }
  } else {
    const zeroOid = '0'.repeat(40);
    lines.push(PktLine.encode(`${zeroOid} capabilities^{}\0${capabilitiesStr}\n`));
  }

  lines.push(PktLine.encodeFlush());

  const response = PktLine.decodeText(PktLine.mergeLines(lines));
  return new Response(response, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-git-receive-pack-advertisement',
      'Cache-Control': 'no-cache',
    },
  });
}

export type Command = {
  oldOid: string;
  newOid: string;
  ref: string;
};

export function parseReceivePackRequest(data: Uint8Array): { commands: Command[]; capabilities: string[]; packfile: Uint8Array } {
  const commands: Command[] = [];
  let capabilities: string[] = [];

  let offset = 0;
  while (offset < data.length) {
    const packet = PktLine.decode(data.subarray(offset));

    const lengthHex = PktLine.decodeText(data.slice(offset, offset + 4));
    const specialPackets = [PktLine.DELIM, PktLine.FLUSH, PktLine.RESPONSE_END];
    const packetLength = specialPackets.includes(lengthHex) ? 4 : Number.parseInt(lengthHex, 16);

    offset += packetLength;

    if (packet.type === 'flush') {
      break;
    }

    if (packet.type === 'data') {
      const line = PktLine.decodeText(packet.data).trim();

      const nullIdx = line.indexOf('\0');
      const refLine = nullIdx === -1 ? line : line.slice(0, Math.max(0, nullIdx));
      const caps = nullIdx === -1 ? [] : line.slice(Math.max(0, nullIdx + 1)).split(' ');

      const parts = refLine.split(' ');
      if (parts.length >= 3) {
        commands.push({
          oldOid: parts[0],
          newOid: parts[1],
          ref: parts[2],
        });
      }

      if (caps.length > 0 && capabilities.length === 0) {
        capabilities = caps;
      }
    }
  }

  const packfile = data.subarray(offset);

  return { commands, capabilities, packfile };
}

export function buildReportStatus(results: RefUpdateResult[], unpackOk: boolean): Response {
  const lines: Uint8Array[] = [];

  if (unpackOk) {
    lines.push(PktLine.encode('unpack ok\n'));
  } else {
    const error = results.find((r) => r.ref === '*')?.error ?? 'unknown error';
    lines.push(PktLine.encode(`unpack ${error}\n`));
  }

  for (const result of results) {
    if (result.ref === '*') continue;

    if (result.ok) {
      lines.push(PktLine.encode(`ok ${result.ref}\n`));
    } else {
      lines.push(PktLine.encode(`ng ${result.ref} ${result.error}\n`));
    }
  }

  lines.push(PktLine.encodeFlush());

  return new Response(PktLine.decodeText(PktLine.mergeLines(lines)), {
    status: 200,
    headers: {
      'Content-Type': 'application/x-git-receive-pack-result',
      'Cache-Control': 'no-cache',
    },
  });
}

export function parseCommand(data: Uint8Array): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let beforeDelim = true;

  let offset = 0;
  while (offset < data.length) {
    const packet = PktLine.decode(data.subarray(offset));

    const lengthHex = PktLine.decodeText(data.slice(offset, offset + 4));
    const specialPackets = [PktLine.DELIM, PktLine.FLUSH, PktLine.RESPONSE_END];
    const packetLength = specialPackets.includes(lengthHex) ? 4 : Number.parseInt(lengthHex, 16);

    offset += packetLength;

    if (packet.type === 'delim') {
      beforeDelim = false;
      continue;
    }

    if (packet.type === 'flush' || packet.type === 'response-end') {
      break;
    }

    if (packet.type === 'data') {
      const line = PktLine.decodeText(packet.data).replace(/\r?\n$/, '');

      if (beforeDelim) {
        if (line.startsWith('command=')) {
          command = line.replace('command=', '');
        }
      } else {
        args.push(line);
      }
    }
  }

  if (!command) {
    const text = PktLine.decodeText(data);
    const match = /command=([a-z-]+)/.exec(text);
    command = match?.[1] ?? '';
  }

  return { command, args };
}

export type FetchRequest = {
  wants: string[];
  haves: string[];
  done: boolean;
  waitForDone: boolean;
  capabilities: {
    thinPack: boolean;
    noProgress: boolean;
    includeTag: boolean;
    ofsDelta: boolean;
    sidebandAll: boolean;
  };
  shallowOptions?: {
    shallow: string[];
    deepen?: number;
    deepenRelative?: boolean;
    deepenSince?: number;
    deepenNot?: string[];
  };
  filterSpec?: string;
};

function applyExactFetchArg(
  arg: string,
  state: {
    capabilities: { thinPack: boolean; noProgress: boolean; includeTag: boolean; ofsDelta: boolean; sidebandAll: boolean };
    setDone: (value: boolean) => void;
    setDeepenRelative: (value: boolean) => void;
    setWaitForDone: (value: boolean) => void;
  },
): boolean {
  switch (arg) {
    case 'done': {
      state.setDone(true);
      return true;
    }
    case 'wait-for-done': {
      state.setWaitForDone(true);
      return true;
    }
    case 'thin-pack': {
      state.capabilities.thinPack = true;
      return true;
    }
    case 'no-progress': {
      state.capabilities.noProgress = true;
      return true;
    }
    case 'include-tag': {
      state.capabilities.includeTag = true;
      return true;
    }
    case 'ofs-delta': {
      state.capabilities.ofsDelta = true;
      return true;
    }
    case 'sideband-all': {
      state.capabilities.sidebandAll = true;
      return true;
    }
    case 'deepen-relative': {
      state.setDeepenRelative(true);
      return true;
    }
    default: {
      return false;
    }
  }
}

export function parseFetchRequest(_data: Uint8Array, args: string[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  let done = false;
  let waitForDone = false;
  const capabilities = {
    thinPack: false,
    noProgress: false,
    includeTag: false,
    ofsDelta: false,
    sidebandAll: false,
  };
  const shallow: string[] = [];
  let deepen: number | undefined;
  let deepenRelative = false;
  let deepenSince: number | undefined;
  const deepenNot: string[] = [];
  let filterSpec: string | undefined;

  for (const arg of args) {
    if (arg.startsWith('want ')) {
      wants.push(arg.slice('want '.length));
      continue;
    }
    if (arg.startsWith('have ')) {
      haves.push(arg.slice('have '.length));
      continue;
    }
    if (
      applyExactFetchArg(arg, {
        capabilities,
        setDone: (value) => {
          done = value;
        },
        setDeepenRelative: (value) => {
          deepenRelative = value;
        },
        setWaitForDone: (value) => {
          waitForDone = value;
        },
      })
    ) {
      continue;
    }
    if (arg.startsWith('shallow ')) {
      shallow.push(arg.slice('shallow '.length));
    } else if (arg.startsWith('deepen ')) {
      deepen = Math.trunc(Number(arg.slice('deepen '.length)));
    } else if (arg.startsWith('deepen-since ')) {
      deepenSince = Math.trunc(Number(arg.slice('deepen-since '.length)));
    } else if (arg.startsWith('deepen-not ')) {
      deepenNot.push(arg.slice('deepen-not '.length));
    } else if (arg.startsWith('filter ')) {
      filterSpec = arg.slice('filter '.length);
    }
  }

  const shallowOptions =
    deepen !== undefined || deepenRelative || deepenSince !== undefined || shallow.length > 0 || deepenNot.length > 0
      ? {
          shallow,
          deepen,
          deepenRelative,
          deepenSince,
          deepenNot,
        }
      : undefined;

  return {
    wants,
    haves,
    done,
    waitForDone,
    capabilities,
    shallowOptions,
    filterSpec,
  };
}

export function shouldSendPackfileForFetch(
  fetchRequest: Pick<FetchRequest, 'wants' | 'haves' | 'done' | 'waitForDone'>,
  commonCommits: string[],
): boolean {
  if (fetchRequest.wants.length === 0) return false;
  if (fetchRequest.done) return true;
  // wait-for-done: never send ready/packfile until the client says done.
  if (fetchRequest.waitForDone) return false;
  // Classic stateless negotiation: single-round ACK+ready+packfile as soon as
  // a common base exists (or for clones with no haves).
  return commonCommits.length > 0 || fetchRequest.haves.length === 0;
}

export async function buildLsRefsResponse(
  refs: Array<{ ref: string; oid: string }>,
  args: string[],
  symbolicHead: string | null,
  readObject: (oid: string) => Promise<{ type: string; object: Uint8Array | string } | null>,
): Promise<Response> {
  const lines: Uint8Array[] = [];

  const refPrefixes: string[] = [];
  let includePeel = false;
  let includeSymrefs = false;

  for (const arg of args) {
    if (arg === 'peel') {
      includePeel = true;
    } else if (arg === 'symrefs') {
      includeSymrefs = true;
    } else if (arg.startsWith('ref-prefix ')) {
      refPrefixes.push(arg.slice('ref-prefix '.length));
    }
  }

  const filteredRefs = refPrefixes.length > 0 ? refs.filter((ref) => refPrefixes.some((prefix) => ref.ref.startsWith(prefix))) : refs;

  for (const { ref, oid } of filteredRefs) {
    let line = `${oid} ${ref}`;

    if (includeSymrefs && ref === 'HEAD' && symbolicHead) {
      line += ` symref-target:${symbolicHead}`;
    }

    lines.push(PktLine.encode(`${line}\n`));

    if (includePeel && ref.startsWith('refs/tags/')) {
      const obj = await readObject(oid);
      if (obj && obj.type === 'tag') {
        const tagContent = typeof obj.object === 'string' ? obj.object : new TextDecoder().decode(obj.object);
        const objectMatch = /^object ([0-9a-f]{40})/m.exec(tagContent);
        if (objectMatch?.[1]) {
          const peeledOid = objectMatch[1];
          lines.push(PktLine.encode(`${peeledOid} ${ref}^{}\n`));
        }
      }
    }
  }

  lines.push(PktLine.encodeFlush());

  return new Response(PktLine.mergeLines(lines) as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-git-upload-pack-result',
      'Cache-Control': 'no-cache',
    },
  });
}

function parsePackfileObjectCount(packfile: Uint8Array): number | null {
  if (packfile.length < 12) {
    return null;
  }

  const signature = new TextDecoder().decode(packfile.slice(0, 4));
  if (signature !== 'PACK') {
    return null;
  }

  const view = new DataView(packfile.buffer, packfile.byteOffset, packfile.byteLength);
  const count = view.getUint32(8, false);

  return count;
}

export type FetchResponseOptions = {
  commonCommits: string[];
  packfileData: Uint8Array | null | undefined;
  noProgress: boolean;
  done: boolean;
  objectCount?: number;
  shallow?: string[];
  unshallow?: string[];
};

export function buildFetchResponse(options: FetchResponseOptions): Response {
  const lines: Uint8Array[] = [];
  const { commonCommits, packfileData, noProgress, done } = options;
  const shallow = options.shallow ?? [];
  const unshallow = options.unshallow ?? [];
  const willSendPackfile = !!packfileData && packfileData.length > 0;

  // Protocol v2 framing (gitprotocol-v2 / fetch-pack.c):
  // - No packfile  -> `acknowledgments` + (NAK | ACK*) + flush (no ready, no delim).
  // - Packfile + !done -> `acknowledgments` + ACK* + ready + delim
  //   [+ shallow-info + delim] + packfile + flush.
  // - Packfile + done -> omit acknowledgments (MUST), send
  //   [shallow-info + delim] + packfile + flush.
  if (!willSendPackfile) {
    if (done) {
      // done + nothing to send: acknowledgments MUST be omitted.
      lines.push(PktLine.encodeFlush());
    } else {
      lines.push(PktLine.encode('acknowledgments\n'));

      if (commonCommits.length === 0) {
        lines.push(PktLine.encode('NAK\n'));
      } else {
        for (const oid of commonCommits) {
          lines.push(PktLine.encode(`ACK ${oid}\n`));
        }
      }

      lines.push(PktLine.encodeFlush());
    }
  } else if (!done) {
    lines.push(PktLine.encode('acknowledgments\n'));

    if (commonCommits.length === 0) {
      // Clone / no-haves case still needs a packfile: NAK + ready.
      lines.push(PktLine.encode('NAK\n'));
    } else {
      for (const oid of commonCommits) {
        lines.push(PktLine.encode(`ACK ${oid}\n`));
      }
    }

    lines.push(PktLine.encode('ready\n'), PktLine.encodeDelim());
  }

  if (willSendPackfile && (shallow.length > 0 || unshallow.length > 0)) {
    lines.push(PktLine.encode('shallow-info\n'));
    for (const oid of shallow) {
      lines.push(PktLine.encode(`shallow ${oid}\n`));
    }
    for (const oid of unshallow) {
      lines.push(PktLine.encode(`unshallow ${oid}\n`));
    }
    lines.push(PktLine.encodeDelim());
  }

  if (willSendPackfile && packfileData) {
    lines.push(PktLine.encode('packfile\n'));

    const objectCount = options.objectCount ?? parsePackfileObjectCount(packfileData);

    if (!noProgress && objectCount !== null) {
      lines.push(
        PktLine.encodeProgress(`remote: Counting objects: ${objectCount}, done.\r\n`),
        PktLine.encodeProgress(`remote: Compressing objects: 100% (${objectCount}/${objectCount}), done.\r\n`),
      );
    }

    for (let offset = 0; offset < packfileData.length; offset += PktLine.MAX_SIDEBAND_PAYLOAD) {
      const end = Math.min(offset + PktLine.MAX_SIDEBAND_PAYLOAD, packfileData.length);
      const chunk = packfileData.subarray(offset, end);

      lines.push(PktLine.encodeSideband(PktLine.SIDEBAND_CHANNEL_PACKFILE, chunk));
    }

    if (!noProgress && objectCount !== null) {
      lines.push(
        PktLine.encodeProgress(`remote: Total ${objectCount} (delta 0), reused ${objectCount} (delta 0), pack-reused 0        \r\n`),
      );
    }

    lines.push(PktLine.encodeFlush());
  }

  return new Response(PktLine.mergeLines(lines) as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-git-upload-pack-result',
      'Cache-Control': 'no-cache',
    },
  });
}

export function getBasicCredentials(req: Request): { username: string; password: string } | null {
  const header = req.headers.get('Authorization') || '';
  const match = /^Basic\s+(\S+)$/i.exec(header);
  if (!match) return null;
  try {
    const decoded = atob(match[1]);
    const idx = decoded.indexOf(':');
    if (idx === -1) return { username: decoded, password: '' };
    const username = decoded.slice(0, idx);
    const password = decoded.slice(idx + 1);
    return { username, password };
  } catch {
    return null;
  }
}

export function getBearerToken(req: Request): string | null {
  const header = req.headers.get('Authorization') || '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ? match[1].trim() : null;
}
