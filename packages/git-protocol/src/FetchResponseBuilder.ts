import { PktLine } from './pkt';
import type { FetchRequest } from './FetchParser';

export type FetchResponseOptions = {
  commonCommits: string[];
  packfileData: Uint8Array | null | undefined;
  noProgress: boolean;
  done: boolean;
  objectCount?: number;
  shallow?: string[];
  unshallow?: string[];
};

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

export function buildFetchErrorResponse(message: string, status = 400): Response {
  return new Response(`ERR ${message}\n`, {
    status,
    headers: {
      'Content-Type': 'application/x-git-upload-pack-result',
      'Cache-Control': 'no-cache',
    },
  });
}

export function shouldSendPackfileForFetch(
  fetchRequest: Pick<FetchRequest, 'wants' | 'haves' | 'done' | 'waitForDone'>,
  commonCommits: string[],
): boolean {
  if (fetchRequest.wants.length === 0) return false;
  if (fetchRequest.done) return true;
  if (fetchRequest.waitForDone) return false;
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

export function buildFetchResponse(options: FetchResponseOptions): Response {
  const lines: Uint8Array[] = [];
  const { commonCommits, packfileData, noProgress, done } = options;
  const shallow = options.shallow ?? [];
  const unshallow = options.unshallow ?? [];
  const willSendPackfile = !!packfileData && packfileData.length > 0;

  if (!willSendPackfile) {
    if (done) {
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
