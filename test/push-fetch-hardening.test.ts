import { describe, expect, it } from 'vitest';
import { PushHandler } from '@edge-git/background/PushHandler';
import { PktLine } from '@edge-git/git-protocol/pkt';

function fakeGit() {
  return {
    indexPack: async () => undefined,
    isAncestor: async () => true,
    applyRefUpdates: async () => [],
    clearCache: () => undefined,
    ensureFreshCache: () => undefined,
    listRefs: async () => ({ refs: [], symbolicHead: null }),
  } as never;
}

function fakeFs(failWrite = false) {
  return {
    promises: {
      writeFile: async () => {
        if (failWrite) throw new Error('SECRET_DISK_PATH=/tmp/x');
      },
      unlink: async () => undefined,
    },
  } as never;
}

function receivePackPayload(): Uint8Array {
  const cmd = `${'0'.repeat(40)} ${'a'.repeat(40)} refs/heads/main\0report-status\n`;
  const parts = [PktLine.encode(cmd), PktLine.encodeFlush(), new TextEncoder().encode('PACK')];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe('push handler hardening', () => {
  it('masks index errors without leaking paths', async () => {
    const handler = new PushHandler({ isoGitFs: fakeFs(true), git: fakeGit(), getFullName: () => 'a/b' });
    const res = await handler.receivePack(receivePackPayload(), { maxCommands: 100, maxPackBytes: 100000 }, []);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('unpack failed: unable to index packfile');
    expect(text).not.toContain('SECRET');
  });

  it('rejects empty commands fail-closed', async () => {
    const handler = new PushHandler({ isoGitFs: fakeFs(), git: fakeGit(), getFullName: () => 'a/b' });
    const empty = (() => {
      const parts = [PktLine.encodeFlush()];
      return parts[0];
    })();
    const res = await handler.receivePack(empty, { maxCommands: 100, maxPackBytes: 100000 }, []);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('no commands');
  });
});
