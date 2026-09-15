import { describe, expect, it } from 'vitest';
import { buildFetchResponse, parseFetchRequest, shouldSendPackfileForFetch } from '@edge-git/git-protocol';

const PACK = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1]);

describe('fetch negotiation decision', () => {
  it('sends packfile in a single round when done is absent with common base (fetch/pull fix)', () => {
    const req = parseFetchRequest(new Uint8Array(), ['want w1', 'have h1', 'thin-pack', 'ofs-delta']);
    expect(req.done).toBe(false);
    expect(req.waitForDone).toBe(false);
    expect(shouldSendPackfileForFetch(req, ['h1'])).toBe(true);
  });

  it('defers packfile when wait-for-done is set without done', () => {
    const req = parseFetchRequest(new Uint8Array(), ['want w1', 'have h1', 'wait-for-done']);
    expect(shouldSendPackfileForFetch(req, ['h1'])).toBe(false);
  });

  it('sends packfile when done even with wait-for-done', () => {
    const req = parseFetchRequest(new Uint8Array(), ['want w1', 'have h1', 'wait-for-done', 'done']);
    expect(shouldSendPackfileForFetch(req, ['h1'])).toBe(true);
  });

  it('returns false with no common base and no done (NAK path)', () => {
    const req = parseFetchRequest(new Uint8Array(), ['want w1', 'have unknown', 'thin-pack']);
    expect(shouldSendPackfileForFetch(req, [])).toBe(false);
  });

  it('sends packfile for clones with no haves even without done', () => {
    const req = parseFetchRequest(new Uint8Array(), ['want w1']);
    expect(shouldSendPackfileForFetch(req, [])).toBe(true);
  });

  it('returns false with no wants', () => {
    const req = parseFetchRequest(new Uint8Array(), ['have h1', 'done']);
    expect(shouldSendPackfileForFetch(req, ['h1'])).toBe(false);
  });
});

describe('fetch response framing', () => {
  it('single-round response carries ACK+ready+packfile', async () => {
    const req = parseFetchRequest(new Uint8Array(), ['want w1', 'have h1']);
    const res = await buildFetchResponse({ commonCommits: ['h1'], packfileData: PACK, noProgress: true, done: req.done });
    const text = await res.text();
    expect(text).toContain('acknowledgments');
    expect(text).toContain('ACK h1');
    expect(text).toContain('ready');
    expect(text).toContain('packfile');
  });

  it('wait-for-done interim response has ACK without ready/packfile', async () => {
    const res = await buildFetchResponse({ commonCommits: ['h1'], packfileData: null, noProgress: true, done: false });
    const text = await res.text();
    expect(text).toContain('ACK h1');
    expect(text).not.toContain('ready');
    expect(text).not.toContain('packfile');
  });
});
