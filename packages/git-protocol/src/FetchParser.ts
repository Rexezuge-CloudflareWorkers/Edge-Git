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

export function validateFetchRequestCounts(
  fetchRequest: Pick<FetchRequest, 'wants' | 'haves' | 'shallowOptions'>,
  limits: FetchCountLimits,
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
    const deepen = shallowOptions.deepen;
    if (deepen !== undefined && (!Number.isSafeInteger(deepen) || deepen <= 0 || deepen > MAX_DEEPEN)) {
      return `invalid deepen: ${String(deepen)}`;
    }
    const deepenSince = shallowOptions.deepenSince;
    if (deepenSince !== undefined) {
      if (!Number.isSafeInteger(deepenSince) || deepenSince < 0 || deepenSince > MAX_DEEPEN_SINCE) {
        return `invalid deepen-since: ${String(deepenSince)}`;
      }
      const nowSeconds = Math.trunc(Date.now() / 1000);
      if (deepenSince > nowSeconds + DEEPEN_SINCE_FUTURE_SKEW_SECONDS) {
        return `invalid deepen-since: ${String(deepenSince)} is in the future`;
      }
    }
  }
  return null;
}
