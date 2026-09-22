import { PktLine } from './pkt';

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

export interface FetchCountLimits {
  maxWants: number;
  maxHaves: number;
}

const MAX_DEEPEN = 1_000_000;
const MAX_DEEPEN_SINCE = 4_294_967_295;
const DEEPEN_SINCE_FUTURE_SKEW_SECONDS = 86_400;

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
    // Fail closed on non-hex/truncated lengths (see ReceiveParser): NaN would
    // silently terminate negotiation instead of surfacing a 400.
    if (!Number.isSafeInteger(packetLength) || packetLength < 4 || packetLength > PktLine.MAX_PKT_SIZE) {
      throw new Error(`Invalid pkt-line length: ${lengthHex}`);
    }

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
    return { command, args };
  }

  return { command, args };
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
      const raw = arg.slice('deepen '.length).trim();
      deepen = /^\d+$/.test(raw) ? Math.trunc(Number(raw)) : NaN;
    } else if (arg.startsWith('deepen-since ')) {
      const raw = arg.slice('deepen-since '.length).trim();
      deepenSince = /^\d+$/.test(raw) ? Math.trunc(Number(raw)) : NaN;
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

export function validateFetchRequestCounts(
  fetchRequest: Pick<FetchRequest, 'wants' | 'haves' | 'shallowOptions'>,
  limits: FetchCountLimits,
  // Injectable clock seam (Otter `IClock` pattern): defaults to wall-clock so
  // production call sites are unchanged; tests pass a fixed epoch to assert
  // the future-skew bound deterministically.
  nowSeconds: number = Math.trunc(Date.now() / 1000),
): string | null {
  if (fetchRequest.wants.length > limits.maxWants) {
    return `too many wants: ${fetchRequest.wants.length} > ${limits.maxWants}`;
  }
  if (fetchRequest.haves.length > limits.maxHaves) {
    return `too many haves: ${fetchRequest.haves.length} > ${limits.maxHaves}`;
  }
  const shallowOptions = fetchRequest.shallowOptions;
  if (shallowOptions) {
    if ((shallowOptions.deepenNot?.length ?? 0) > limits.maxHaves) {
      return `too many deepen-not: ${shallowOptions.deepenNot?.length} > ${limits.maxHaves}`;
    }
    if ((shallowOptions.shallow?.length ?? 0) > limits.maxHaves) {
      return `too many shallow lines: ${shallowOptions.shallow?.length} > ${limits.maxHaves}`;
    }
    const deepen = shallowOptions.deepen;
    if (deepen !== undefined && (!Number.isSafeInteger(deepen) || deepen <= 0 || deepen > MAX_DEEPEN)) {
      return `invalid deepen: ${String(deepen)}`;
    }
    const deepenSince = shallowOptions.deepenSince;
    if (deepenSince !== undefined) {
      if (!Number.isSafeInteger(deepenSince) || deepenSince < 0 || deepenSince > MAX_DEEPEN_SINCE) {
        return `invalid deepen-since: ${String(deepenSince)}`;
      }
      if (deepenSince > nowSeconds + DEEPEN_SINCE_FUTURE_SKEW_SECONDS) {
        return `invalid deepen-since: ${String(deepenSince)} is in the future`;
      }
    }
  }
  return null;
}

const OID_RE = /^[0-9a-f]{40}$/i;

// want/have/shallow lines must reference full object ids. Malformed oids
// previously fell through to empty packs; reject them instead.
export function validateFetchRequestOids(fetchRequest: Pick<FetchRequest, 'wants' | 'haves' | 'shallowOptions'>): string | null {
  const shallowLines = fetchRequest.shallowOptions?.shallow ?? [];
  for (const oid of fetchRequest.wants) {
    if (!OID_RE.test(oid)) return `invalid want oid: ${oid}`;
  }
  for (const oid of fetchRequest.haves) {
    if (!OID_RE.test(oid)) return `invalid have oid: ${oid}`;
  }
  for (const oid of shallowLines) {
    if (!OID_RE.test(oid)) return `invalid shallow oid: ${oid}`;
  }
  return null;
}

const BLOB_LIMIT_RE = /^blob:limit=(\d+)$/;
const MAX_BLOB_LIMIT_BYTES = 100_000_000;
const SUPPORTED_FILTERS = new Set(['blob:none', 'tree:0']);

// Only filters the pack collector implements. Unknown filters previously
// fell through to an unfiltered pack while the client believed it held a
// partial clone; reject them instead.
export function validateFilterSpec(filterSpec: string | undefined): string | null {
  const filter = filterSpec?.trim() ?? '';
  if (filter === '' || SUPPORTED_FILTERS.has(filter)) return null;
  const limitMatch = BLOB_LIMIT_RE.exec(filter);
  if (limitMatch) {
    const value = Number(limitMatch[1]);
    if (Number.isSafeInteger(value) && value >= 0 && value <= MAX_BLOB_LIMIT_BYTES) return null;
    return `unsupported filter: ${filterSpec ?? ''}`;
  }
  return `unsupported filter: ${filterSpec ?? ''}`;
}
