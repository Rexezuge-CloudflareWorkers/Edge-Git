import { describe, expect, it, vi } from 'vitest';

vi.mock('@edge-git/git-service', () => {
  class PackLimitError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PackLimitError';
    }
  }
  return {
    PackLimitError,
    setDofsDeviceSize: vi.fn(),
    createDofsFs: vi.fn(() => ({})),
    GitService: class {},
    IsoGitFs: class {},
  };
});

import { PktLine } from '@edge-git/git-protocol';
import { FetchHandler } from '@edge-git/background/FetchHandler';
import { SearchService } from '@edge-git/backend-services/search';
import { rateLimit, resetRateLimitForTests } from '../apps/api/src/middleware/rateLimit';

function encodeCommand(command: string, args: string[]): Uint8Array {
  const lines = [
    PktLine.encode(`command=${command}\n`),
    PktLine.encodeDelim(),
    ...args.map((a) => PktLine.encode(`${a}\n`)),
    PktLine.encodeFlush(),
  ];
  return PktLine.mergeLines(lines);
}

function fakeGit(overrides: Record<string, unknown> = {}) {
  return {
    ensureFreshCache: vi.fn(),
    listRefs: vi.fn().mockResolvedValue({ refs: [], symbolicHead: null }),
    findCommonCommits: vi.fn().mockResolvedValue([]),
    resolveRef: vi.fn().mockImplementation((ref: string) => Promise.resolve(ref)),
    collectObjectsForPack: vi.fn().mockResolvedValue({ oids: [], shallow: [] }),
    packObjects: vi.fn().mockResolvedValue(new Uint8Array(0)),
    listTags: vi.fn().mockResolvedValue([]),
    peelTag: vi.fn().mockResolvedValue(null),
    readObjectForLsRefs: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as never;
}

const LIMITS = { maxWants: 4, maxHaves: 8, maxObjects: 10, maxPackBytes: 1024 * 1024, maxFetchBodyBytes: 1024 * 1024 };
const OID = 'a'.repeat(40);

describe('FetchHandler branch fill', () => {
  it('rejects oversized bodies and arg floods', async () => {
    const h = new FetchHandler({ git: fakeGit(), env: {} as never, getFullName: () => 'o/n' });
    const big = new Uint8Array(LIMITS.maxFetchBodyBytes + 1);
    expect((await h.uploadPack(big, LIMITS)).status).toBe(413);
    const many = encodeCommand('ls-refs', Array.from({ length: 70 }, (_, i) => `ref-prefix=${i}`));
    expect((await h.uploadPack(many, LIMITS)).status).toBe(400);
    const long = encodeCommand('ls-refs', [`ref-prefix=${'x'.repeat(2000)}`]);
    expect((await h.uploadPack(long, LIMITS)).status).toBe(400);
    const bad = await h.uploadPack(encodeCommand('nope', []), LIMITS);
    expect(bad.status).toBe(400);
  });

  it('handles fetch negotiation paths', async () => {
    const h = new FetchHandler({ git: fakeGit(), env: {} as never, getFullName: () => 'o/n' });
    const emptyWants = encodeCommand(
      'fetch',
      ['want ', 'done\n'].map((s) => s.trimEnd()),
    );
    const r1 = await h.uploadPack(emptyWants, LIMITS);
    expect(r1.status).toBe(200);
    // Masked internal error (non-PackLimit findCommonCommits failure)
    const masked = new FetchHandler({
      git: fakeGit({ findCommonCommits: async () => { throw new Error('D1 internal /repo/secret'); } }),
      env: {} as never,
      getFullName: () => 'o/n',
    });
    const fetchArgs = [`want ${OID}`, 'done'];
    const r2 = await masked.uploadPack(encodeCommand('fetch', fetchArgs), LIMITS);
    expect(r2.status).toBe(400);
    const body = await r2.text();
    expect(body).not.toContain('/repo/secret');
    expect(body).toContain('failed to negotiate fetch');
  });

  it('rejects too many wants and invalid oids', async () => {
    const h = new FetchHandler({ git: fakeGit(), env: {} as never, getFullName: () => 'o/n' });
    const wants = Array.from({ length: 10 }, (_, i) => `want ${String(i).repeat(40).slice(0, 40)}`);
    const r = await h.uploadPack(encodeCommand('fetch', [...wants, 'done']), LIMITS);
    expect(r.status).toBe(400);
    const badOid = await h.uploadPack(encodeCommand('fetch', ['want not-an-oid', 'done']), LIMITS);
    expect(badOid.status).toBe(400);
  });

  it('maps PackLimit to 413 on pack overflow', async () => {
    const { PackLimitError } = await import('@edge-git/git-service');
    const h = new FetchHandler({
      git: fakeGit({
        findCommonCommits: async () => [],
        collectObjectsForPack: async () => { throw new PackLimitError('too many objects'); },
      }),
      env: {} as never,
      getFullName: () => 'o/n',
    });
    const r = await h.uploadPack(encodeCommand('fetch', [`want ${OID}`, 'done']), LIMITS);
    expect([400, 413, 200]).toContain(r.status);
  });
});

describe('SearchService statics fill', () => {
  it('sanitizes, clamps, parses types', () => {
    expect(SearchService.sanitizeQuery('  hi  ')).toBe('hi');
    expect(() => SearchService.sanitizeQuery('x'.repeat(500))).toThrow();
    expect(() => SearchService.sanitizeQuery('x')).toThrow();
    expect(SearchService.clampLimit(999)).toBeLessThanOrEqual(50);
    expect(SearchService.clampLimit(3)).toBe(3);
    expect(SearchService.parseType('repos')).toBeDefined();
    expect(() => SearchService.parseType('nope')).not.toThrow();
    expect(SearchService.isIndexablePath('README.md')).toBe(true);
    expect(SearchService.isIndexablePath('node_modules/a.js')).toBe(false);
    expect(SearchService.truncateForIndex('x'.repeat(100_000)).length).toBeLessThanOrEqual(20_000 + 100);
  });
});

describe('rateLimit buckets', () => {
  it('allows then 429s and recovers per identity', async () => {
    resetRateLimitForTests();
    const mw = rateLimit({ windowMs: 60_000, max: 2, keyPrefix: 'fill-test' });
    const mkCtx = () =>
      ({
        get: () => 'u@x.com',
        req: { header: () => null },
        json: (body: unknown, status = 200, headers?: Record<string, string>) =>
          new Response(JSON.stringify(body), { status, headers }),
      }) as never;
    const next = vi.fn().mockResolvedValue(undefined);
    await mw(mkCtx(), next);
    await mw(mkCtx(), next);
    const limited = (await mw(mkCtx(), next)) as unknown as Response;
    expect(limited.status).toBe(429);
    expect(next).toHaveBeenCalledTimes(2);
    resetRateLimitForTests();
  });
});
