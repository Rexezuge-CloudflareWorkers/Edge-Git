import { PktLine } from './pkt';

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
