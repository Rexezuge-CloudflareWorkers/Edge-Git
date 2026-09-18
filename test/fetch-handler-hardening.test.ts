import { describe, expect, it, vi } from 'vitest';

// `FetchHandler` value-imports `PackLimitError` from the git-service barrel,
// which pulls `dofs` → `cloudflare:*` (unavailable in the node unit pool).
// Stub it: this suite injects git as a fake anyway.
vi.mock('@edge-git/git-service', () => {
  class PackLimitError extends Error {}
  return { PackLimitError };
});

import { PktLine } from '@edge-git/git-protocol';
import { FetchHandler } from '@edge-git/background/FetchHandler';

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
    ...overrides,
  } as never;
}

const limits = { maxWants: 64, maxHaves: 512, maxObjects: 10, maxPackBytes: 1024 * 1024, maxFetchBodyBytes: 1024 * 1024 };

describe('FetchHandler hardening', () => {
  it('rejects ls-refs arg floods before git I/O', async () => {
    const git = fakeGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const data = encodeCommand('ls-refs', Array.from({ length: 65 }, (_, i) => `arg-${i}`));
    const res = await handler.uploadPack(data, limits);
    expect(res.status).toBe(400);
    expect(git.listRefs).not.toHaveBeenCalled();
  });

  it('rejects oversized single ls-refs args', async () => {
    const git = fakeGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const data = encodeCommand('ls-refs', [`x`.repeat(1025)]);
    const res = await handler.uploadPack(data, limits);
    expect(res.status).toBe(400);
    expect(git.listRefs).not.toHaveBeenCalled();
  });

  it('rejects fetch bodies over maxFetchBodyBytes', async () => {
    const git = fakeGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const res = await handler.uploadPack(new Uint8Array(11), { ...limits, maxFetchBodyBytes: 10 });
    expect(res.status).toBe(413);
  });

  it('rejects invalid deepen-not entries before resolveRef fan-out', async () => {
    const git = fakeGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const want = 'a'.repeat(40);
    const data = encodeCommand('fetch', [`want ${want}`, 'done', `deepen-not not a ref!!`]);
    const res = await handler.uploadPack(data, limits);
    expect(res.status).toBe(400);
    expect(git.resolveRef).not.toHaveBeenCalled();
  });

  it('rejects want floods over maxWants', async () => {
    const git = fakeGit();
    const handler = new FetchHandler({ git, env: {} as Env, getFullName: () => 'a/b' });
    const args = Array.from({ length: 11 }, () => `want ${'a'.repeat(40)}`);
    args.push('done');
    const data = encodeCommand('fetch', args);
    const res = await handler.uploadPack(data, { ...limits, maxWants: 10 });
    expect(res.status).toBe(400);
    expect(git.collectObjectsForPack).not.toHaveBeenCalled();
  });
});
