import { PktLine } from './pkt';
import type { RefUpdateResult } from './types';

export type Command = {
  oldOid: string;
  newOid: string;
  ref: string;
};

export interface ReceiveCountLimits {
  maxCommands: number;
  maxPackBytes: number;
}

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

export function validateReceivePackCounts(
  commandCount: number,
  packfileLength: number,
  limits: ReceiveCountLimits,
): string | null {
  if (commandCount > limits.maxCommands) {
    return `too many ref updates: ${commandCount} > ${limits.maxCommands}`;
  }
  if (packfileLength > limits.maxPackBytes) {
    return `pack too large: ${packfileLength} > ${limits.maxPackBytes} bytes`;
  }
  return null;
}
