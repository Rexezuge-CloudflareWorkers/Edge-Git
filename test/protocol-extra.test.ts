import { describe, expect, it } from 'vitest';
import {
  PktLine,
  advertiseReceivePack,
  advertiseUploadPack,
  buildFetchResponse,
  buildLsRefsResponse,
  buildReportStatus,
  getBasicCredentials,
  getBearerToken,
  parseCommand,
  parseFetchRequest,
  parseReceivePackRequest,
} from '@edge-git/git-protocol';

describe('advertise', () => {
  it('advertises upload-pack v2 capabilities', async () => {
    const res = await advertiseUploadPack();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('version 2');
    expect(text).toContain('ls-refs');
  });

  it('advertises receive-pack refs with symref', async () => {
    const res = await advertiseReceivePack(() => Promise.resolve({ refs: [{ ref: 'refs/heads/main', oid: 'a'.repeat(40) }], symbolicHead: 'refs/heads/main' }));
    const text = await res.text();
    expect(text).toContain('refs/heads/main');
    expect(text).toContain('symref=HEAD');
  });

  it('advertises empty repo with capabilities', async () => {
    const res = await advertiseReceivePack(() => Promise.resolve({ refs: [], symbolicHead: null }));
    expect(await res.text()).toContain('capabilities^{}');
  });
});

describe('receive-pack parsing', () => {
  it('handles multiple commands and empty capabilities', () => {
    const zero = '0'.repeat(40);
    const buf = PktLine.mergeLines([
      PktLine.encode(`${zero} ${'1'.repeat(40)} refs/heads/new\0report-status atomic\n`),
      PktLine.encode(`${'1'.repeat(40)} ${zero} refs/heads/old\n`),
      PktLine.encodeFlush(),
    ]);
    const { commands, capabilities } = parseReceivePackRequest(buf);
    expect(commands).toHaveLength(2);
    expect(capabilities).toEqual(['report-status', 'atomic']);
  });

  it('reports unpack failure', async () => {
    const res = await buildReportStatus([{ ref: '*', ok: false, error: 'boom' }], false);
    expect(await res.text()).toContain('unpack boom');
  });

  it('reports per-ref failures', async () => {
    const res = await buildReportStatus(
      [
        { ref: 'refs/heads/a', ok: true },
        { ref: 'refs/heads/b', ok: false, error: 'rejected' },
      ],
      true,
    );
    const text = await res.text();
    expect(text).toContain('ok refs/heads/a');
    expect(text).toContain('ng refs/heads/b rejected');
  });
});

describe('upload-pack parsing', () => {
  it('parses fetch shallow/filter options', () => {
    const req = parseFetchRequest(new Uint8Array(), [
      'want abc',
      'shallow xyz',
      'deepen 5',
      'deepen-relative',
      'deepen-since 123',
      'deepen-not refs/heads/x',
      'filter blob:none',
      'thin-pack',
      'ofs-delta',
      'include-tag',
      'sideband-all',
      'wait-for-done',
    ]);
    expect(req.shallowOptions?.deepen).toBe(5);
    expect(req.filterSpec).toBe('blob:none');
    expect(req.capabilities.thinPack).toBe(true);
    expect(req.capabilities.sidebandAll).toBe(true);
    expect(req.waitForDone).toBe(true);
  });

  it('falls back to regex command extraction', () => {
    const framed = PktLine.mergeLines([PktLine.encode('command=fetch\n'), PktLine.encodeFlush()]);
    expect(parseCommand(framed).command).toBe('fetch');
    const noCommand = PktLine.mergeLines([PktLine.encode('hello\n'), PktLine.encodeFlush()]);
    expect(parseCommand(noCommand)).toEqual({ command: '', args: [] });
  });

  it('builds ls-refs with prefix filter and symrefs', async () => {
    const refs = [
      { ref: 'HEAD', oid: 'a'.repeat(40) },
      { ref: 'refs/heads/main', oid: 'b'.repeat(40) },
      { ref: 'refs/tags/v1', oid: 'c'.repeat(40) },
    ];
    const res = await buildLsRefsResponse(refs, ['symrefs', 'ref-prefix refs/heads/'], 'refs/heads/main', () => Promise.resolve(null));
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('refs/heads/main');
    expect(text).not.toContain('refs/tags/v1');
  });

  it('peels annotated tags in ls-refs', async () => {
    const tagOid = 'c'.repeat(40);
    const peeled = 'd'.repeat(40);
    const res = await buildLsRefsResponse(
      [{ ref: 'refs/tags/v1', oid: tagOid }],
      ['peel'],
      null,
      () => Promise.resolve({ type: 'tag', object: `object ${peeled}\ntype commit\ntag v1\n` }),
    );
    const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
    expect(text).toContain(`${peeled} refs/tags/v1^{}`);
  });

  it('builds fetch packfile with progress sideband', async () => {
    const pack = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1]);
    const res = await buildFetchResponse({ commonCommits: ['a'.repeat(40)], packfileData: pack, noProgress: false, done: true });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(pack.length);
  });

  it('acknowledges common commits without packfile via flush', async () => {
    const res = await buildFetchResponse({ commonCommits: ['a'.repeat(40)], packfileData: null, noProgress: true, done: false });
    const text = await res.text();
    expect(text).toContain('ACK');
    expect(text).not.toContain('ready');
    expect(text).not.toContain('packfile');
  });

  it('emits shallow-info section with packfile', async () => {
    const pack = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1]);
    const res = await buildFetchResponse({
      commonCommits: [],
      packfileData: pack,
      noProgress: true,
      done: true,
      shallow: ['b'.repeat(40)],
      unshallow: ['c'.repeat(40)],
    });
    const text = await res.text();
    expect(text).toContain('shallow-info');
    expect(text).toContain(`shallow ${'b'.repeat(40)}`);
    expect(text).toContain(`unshallow ${'c'.repeat(40)}`);
    expect(text).toContain('packfile');
  });
});

describe('auth header helpers', () => {
  it('decodes basic credentials and bearer tokens', () => {
    const basic = `Basic ${btoa('alice:s3cret')}`;
    expect(getBasicCredentials(new Request('https://x/', { headers: { Authorization: basic } }))).toEqual({ username: 'alice', password: 's3cret' });
    expect(getBasicCredentials(new Request('https://x/'))).toBeNull();
    expect(getBasicCredentials(new Request('https://x/', { headers: { Authorization: 'Basic !!!' } }))).toBeNull();
    expect(getBearerToken(new Request('https://x/', { headers: { Authorization: 'Bearer tok123 ' } }))).toBe('tok123');
    expect(getBearerToken(new Request('https://x/'))).toBeNull();
  });

  it('decodes pkt error packets and rejects oversize payloads', () => {
    const err = PktLine.decode(PktLine.encode('ERR something broke'));
    expect(err).toEqual({ type: 'error', message: 'something broke' });
    expect(() => PktLine.encode(new Uint8Array(PktLine.MAX_PAYLOAD_SIZE + 1))).toThrow();
    expect(() => PktLine.encodeSideband(1, new Uint8Array(PktLine.MAX_SIDEBAND_PAYLOAD + 1))).toThrow();
    expect(() => PktLine.decode(new Uint8Array([0x30]))).toThrow();
  });
});
