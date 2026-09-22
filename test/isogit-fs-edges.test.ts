import { describe, expect, it } from 'vitest';
import { IsoGitFs } from '@edge-git/git-service/IsoGitFs';
import { normalizePath } from '@edge-git/git-service/ErrorNormalizer';

function fakeDofs(overrides: Record<string, unknown> = {}) {
  return {
    read: (path: string) => {
      if (path === '/missing') throw new Error('ENOENT');
      return new TextEncoder().encode(`content:${path}`);
    },
    writeFile: () => undefined,
    unlink: (path: string) => {
      if (path === '/missing') throw new Error('ENOENT');
    },
    listDir: (path: string) => {
      if (path === '/empty') return [] as string[];
      return ['.', '..', 'a.txt', 'b.txt'];
    },
    mkdir: () => undefined,
    rmdir: () => undefined,
    stat: (path: string) => {
      if (path === '/missing') throw new Error('ENOENT');
      return { isFile: true, isDirectory: false, size: 5, mode: 0o100644 } as never;
    },
    readlink: (path: string) => {
      if (path === '/link') return '/target';
      throw new Error('ENOENT');
    },
    symlink: () => undefined,
    ...overrides,
  } as never;
}

describe('IsoGitFs edge cases', () => {
  it('readFile decodes utf8 vs buffer', async () => {
    const fs = new IsoGitFs(fakeDofs()).getPromiseFsClient().promises;
    expect(await fs.readFile('/f.txt', 'utf8')).toContain('content:');
    const buf = (await fs.readFile('/f.txt', 'buffer')) as Uint8Array;
    expect(buf).toBeInstanceOf(Uint8Array);
    const def = (await fs.readFile('/f.txt')) as Uint8Array;
    expect(def).toBeInstanceOf(Uint8Array);
  });

  it('readFile annotates ENOENT with path', async () => {
    const fs = new IsoGitFs(fakeDofs()).getPromiseFsClient().promises;
    await expect(fs.readFile('/missing')).rejects.toMatchObject({ path: '/missing' });
  });

  it('writeFile copies ArrayBufferView byteOffset (no aliasing)', async () => {
    let written: unknown;
    const dofs = fakeDofs({
      writeFile: (path: string, data: unknown) => {
        written = data;
      },
    });
    const fs = new IsoGitFs(dofs).getPromiseFsClient().promises;
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    const view = new Uint8Array(backing.buffer, 1, 3);
    await fs.writeFile('/f.bin', view);
    expect(written).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(written as ArrayBuffer)]).toEqual([1, 2, 3]);
    // Mutating the source afterwards must not affect the copy.
    view[0] = 99;
    expect([...new Uint8Array(written as ArrayBuffer)][0]).toBe(1);
  });

  it('readdir filters . and ..', async () => {
    const fs = new IsoGitFs(fakeDofs()).getPromiseFsClient().promises;
    expect(await fs.readdir('/')).toEqual(['a.txt', 'b.txt']);
  });

  it('stat defaults epoch times and mode/nlink/uid/gid', async () => {
    const fs = new IsoGitFs(fakeDofs()).getPromiseFsClient().promises;
    const st = await fs.stat('/f.txt');
    expect(st.atime.getTime()).toBe(0);
    expect(st.mtime.getTime()).toBe(0);
    expect(st.nlink).toBe(1);
    expect(st.uid).toBe(0);
    expect(st.isFile()).toBe(true);
    expect(st.isSymbolicLink()).toBe(false);
  });

  it('lstat detects symlink vs missing (ENOENT→false, other→reject)', async () => {
    const fs = new IsoGitFs(fakeDofs()).getPromiseFsClient().promises;
    expect((await fs.lstat('/link')).isSymbolicLink()).toBe(true);
    expect((await fs.lstat('/f.txt')).isSymbolicLink()).toBe(false);
    const bad = new IsoGitFs(
      fakeDofs({
        readlink: () => {
          throw new Error('EACCES');
        },
      }),
    ).getPromiseFsClient().promises;
    await expect(bad.lstat('/x')).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('normalizePath collapses escapes and backslashes', () => {
    expect(normalizePath('a\\b\\c')).toBe('/a/b/c');
    expect(normalizePath('/a/./b')).toBe('/a/b');
    expect(normalizePath('/a/../b')).toBe('/b');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/a/b?query=1#frag')).toBe('/a/b');
  });
});
