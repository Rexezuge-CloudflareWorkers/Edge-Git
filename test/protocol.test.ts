import { describe, expect, it } from 'vitest';
import { PktLine, parseCommand, parseFetchRequest, parseReceivePackRequest, buildFetchResponse, buildReportStatus } from '@edge-git/git-protocol';

describe('git protocol', () => {
  it('parses ls-refs command framing', () => {
    const buf = PktLine.mergeLines([PktLine.encode('command=ls-refs\n'), PktLine.encodeDelim(), PktLine.encode('peel\n'), PktLine.encodeFlush()]);
    const { command, args } = parseCommand(buf);
    expect(command).toBe('ls-refs');
    expect(args).toContain('peel');
  });

  it('parses fetch request wants/haves/done', () => {
    const req = parseFetchRequest(new Uint8Array(), ['want abc123', 'have def456', 'done', 'no-progress']);
    expect(req.wants).toEqual(['abc123']);
    expect(req.haves).toEqual(['def456']);
    expect(req.done).toBe(true);
    expect(req.waitForDone).toBe(false);
    expect(req.capabilities.noProgress).toBe(true);
  });

  it('parses wait-for-done negotiation flag', () => {
    const req = parseFetchRequest(new Uint8Array(), ['want abc123', 'have def456', 'wait-for-done']);
    expect(req.done).toBe(false);
    expect(req.waitForDone).toBe(true);
  });

  it('parses receive-pack commands and packfile split', () => {
    const cmd = PktLine.encode('1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 refs/heads/main\0report-status\n');
    const buf = PktLine.mergeLines([cmd, PktLine.encodeFlush(), new TextEncoder().encode('PACKDATA')]);
    const { commands, capabilities, packfile } = parseReceivePackRequest(buf);
    expect(commands).toHaveLength(1);
    expect(commands[0].ref).toBe('refs/heads/main');
    expect(capabilities).toContain('report-status');
    expect(new TextDecoder().decode(packfile)).toBe('PACKDATA');
  });

  it('builds fetch NAK+flush response when not done without packfile', async () => {
    const res = await buildFetchResponse({ commonCommits: [], packfileData: null, noProgress: true, done: false });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('git-upload-pack-result');
    const text = await res.text();
    expect(text).toContain('NAK');
    expect(text).not.toContain('ready');
    expect(text).not.toContain('packfile');
  });

  it('builds single-round ACK+ready+packfile when not done with common', async () => {
    const pack = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1]);
    const res = await buildFetchResponse({
      commonCommits: ['a'.repeat(40)],
      packfileData: pack,
      noProgress: true,
      done: false,
    });
    const text = await res.text();
    expect(text).toContain('ACK');
    expect(text).toContain('ready');
    expect(text).toContain('packfile');
  });

  it('omits acknowledgments when done with packfile', async () => {
    const pack = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1]);
    const res = await buildFetchResponse({
      commonCommits: ['a'.repeat(40)],
      packfileData: pack,
      noProgress: true,
      done: true,
    });
    const text = await res.text();
    expect(text).not.toContain('acknowledgments');
    expect(text).toContain('packfile');
  });

  it('builds report-status ok', async () => {
    const res = await buildReportStatus([{ ref: 'refs/heads/main', ok: true }], true);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('unpack ok');
    expect(text).toContain('ok refs/heads/main');
  });
});
