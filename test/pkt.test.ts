import { describe, expect, it } from 'vitest';
import { PktLine } from '@edge-git/git-protocol';

describe('PktLine', () => {
  it('encodes and decodes a data packet', () => {
    const encoded = PktLine.encode('hello\n');
    const packet = PktLine.decode(encoded);
    expect(packet.type).toBe('data');
    if (packet.type === 'data') {
      expect(PktLine.decodeText(packet.data)).toBe('hello\n');
    }
  });

  it('handles flush/delim/response-end', () => {
    expect(PktLine.decode(PktLine.encodeFlush()).type).toBe('flush');
    expect(PktLine.decode(PktLine.encodeDelim()).type).toBe('delim');
    expect(PktLine.decode(PktLine.encodeResponseEnd()).type).toBe('response-end');
  });

  it('round-trips sideband progress', () => {
    const pkt = PktLine.encodeProgress('remote: test\n');
    const decoded = PktLine.decode(pkt);
    expect(decoded.type).toBe('data');
  });

  it('merges lines', () => {
    const merged = PktLine.mergeLines([PktLine.encode('a\n'), PktLine.encodeFlush()]);
    expect(merged.length).toBeGreaterThan(4);
  });
});
