/**
 * Contains a custom FS adapter for isomorphic-git using dofs (Durable Object File System).
 * @see https://isomorphic-git.org/docs/en/fs
 * @see https://github.com/benallfree/dofs/
 */

import type { Fs } from 'dofs';
import { ErrorNormalizer, normalizePath } from './ErrorNormalizer';

type TextEncoding = 'utf8' | 'buffer';

interface StatsLike {
  isFile(): boolean;
  isDirectory(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isSymbolicLink(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  size: number;
  blksize: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
}

/**
 * A file system abstraction layer that wraps a dofs instance
 * to provide a Node.js-like `fs.promises` API for isomorphic-git.
 */
export class IsoGitFs {
  private readonly dofs: Fs;
  private readonly normalizer = new ErrorNormalizer();

  constructor(dofs: Fs) {
    this.dofs = dofs;
  }

  getPromiseFsClient() {
    const fs = {
      promises: {
        readFile: this.readFile.bind(this),
        writeFile: this.writeFile.bind(this),
        unlink: this.unlink.bind(this),
        readdir: this.readdir.bind(this),
        mkdir: this.mkdir.bind(this),
        rmdir: this.rmdir.bind(this),
        stat: this.stat.bind(this),
        lstat: this.lstat.bind(this),
        readlink: this.readlink.bind(this),
        symlink: this.symlink.bind(this),
      },
    };
    return fs;
  }

  readFile(path: string, options?: TextEncoding | { encoding?: TextEncoding }): Promise<Uint8Array | string> {
    const encoding = typeof options === 'string' ? options : options?.encoding;
    const normalizedPath = normalizePath(path);
    try {
      const data: unknown = this.dofs.read(normalizedPath, { encoding });
      if (typeof data === 'string') {
        if (!encoding || encoding === 'buffer') {
          // dofs returned a binary-as-string payload: decode latin1 (one byte
          // per char) so pack bytes survive. `TextEncoder` (utf8) would
          // corrupt bytes >= 0x80.
          return Promise.resolve(Uint8Array.from(data, (ch) => (ch.codePointAt(0) ?? 0) & 0xff));
        }
        return Promise.resolve(data);
      }
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      if (!encoding || encoding === 'buffer') return Promise.resolve(bytes);
      return Promise.resolve(new TextDecoder('utf-8').decode(bytes));
    } catch (error) {
      return this.normalizer.annotateAndReject(error, 'readFile', normalizedPath);
    }
  }

  async writeFile(filepath: string, data: string | ArrayBufferView | ArrayBuffer, options?: TextEncoding | { encoding?: TextEncoding }) {
    const encoding = typeof options === 'string' ? options : options?.encoding;
    let arrayLike: ArrayBuffer | string;
    if (typeof data === 'string' || data instanceof ArrayBuffer) {
      arrayLike = data;
    } else if (data instanceof Uint8Array) {
      // Zero-copy slice: avoids `new Uint8Array(len).set(...)` on 50MB packs.
      arrayLike = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    } else {
      const view = data;
      arrayLike = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    }
    const normalizedPath = normalizePath(filepath);
    try {
      await this.dofs.writeFile(normalizedPath, arrayLike, { encoding });
    } catch (error) {
      this.normalizer.annotateAndThrow(error, 'writeFile', normalizedPath);
    }
  }

  unlink(path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    try {
      this.dofs.unlink(normalizedPath);
      return Promise.resolve();
    } catch (error) {
      return this.normalizer.annotateAndReject(error, 'unlink', normalizedPath);
    }
  }

  readdir(path: string): Promise<string[]> {
    const normalizedPath = normalizePath(path);
    try {
      const names = this.dofs.listDir(normalizedPath, {});
      return Promise.resolve(names.filter((n) => n !== '.' && n !== '..'));
    } catch (error) {
      return this.normalizer.annotateAndReject(error, 'readdir', normalizedPath);
    }
  }

  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
    const normalizedPath = normalizePath(path);
    try {
      this.dofs.mkdir(normalizedPath, { recursive: true, ...options });
      return Promise.resolve();
    } catch (error) {
      return this.normalizer.annotateAndReject(error, 'mkdir', normalizedPath);
    }
  }

  rmdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const normalizedPath = normalizePath(path);
    try {
      this.dofs.rmdir(normalizedPath, { recursive: true, ...options });
      return Promise.resolve();
    } catch (error) {
      return this.normalizer.annotateAndReject(error, 'rmdir', normalizedPath);
    }
  }

  statCore(path: string, detectSymlink: boolean): Promise<StatsLike> {
    let isSymlink = false;
    const normalizedPath = normalizePath(path);
    // Fast path: content-addressed objects are never symlinks. Skips one
    // `readlink` SQLite row per `lstat` during pack walks and log traversals,
    // which dominate `rows_read` on fetch-heavy workloads.
    const isObjectPath = normalizedPath.startsWith('/repo/objects/');
    if (detectSymlink && !isObjectPath) {
      try {
        this.dofs.readlink(normalizedPath);
        isSymlink = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'ENOENT' || message.includes('ENOENT') || message.includes('EINVAL') || message.includes('ENOTDIR')) {
          isSymlink = false;
        } else {
          return this.normalizer.annotateAndReject(error, 'lstat', normalizedPath);
        }
      }
    }

    try {
      const stat = this.dofs.stat(normalizedPath);
      const atime = stat.atime ? new Date(stat.atime) : new Date(0);
      const mtime = stat.mtime ? new Date(stat.mtime) : new Date(0);
      const ctime = stat.ctime ? new Date(stat.ctime) : new Date(0);
      const birthtime = stat.crtime ? new Date(stat.crtime) : new Date(0);

      const nodeStat: StatsLike = {
        isFile: () => stat.isFile,
        isDirectory: () => stat.isDirectory,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isSymbolicLink: () => isSymlink,
        isFIFO: () => false,
        isSocket: () => false,
        dev: 0,
        ino: 0,
        mode: stat.mode ?? 0,
        nlink: stat.nlink ?? 1,
        uid: stat.uid ?? 0,
        gid: stat.gid ?? 0,
        rdev: stat.rdev ?? 0,
        size: stat.size ?? 0,
        blksize: stat.blksize ?? 4096,
        blocks: stat.blocks ?? 0,
        atimeMs: atime.getTime(),
        mtimeMs: mtime.getTime(),
        ctimeMs: ctime.getTime(),
        birthtimeMs: birthtime.getTime(),
        atime,
        mtime,
        ctime,
        birthtime,
      };

      return Promise.resolve(nodeStat);
    } catch (error) {
      return this.normalizer.annotateAndReject(error, detectSymlink ? 'lstat' : 'stat', normalizedPath);
    }
  }

  stat(path: string): Promise<StatsLike> {
    return this.statCore(path, false);
  }

  lstat(path: string): Promise<StatsLike> {
    return this.statCore(path, true);
  }

  readlink(path: string): Promise<string> {
    const normalizedPath = normalizePath(path);
    try {
      return Promise.resolve(this.dofs.readlink(normalizedPath));
    } catch (error) {
      return this.normalizer.annotateAndReject(error, 'readlink', normalizedPath);
    }
  }

  symlink(target: string, path: string): Promise<void> {
    const normalizedPath = normalizePath(path);
    try {
      this.dofs.symlink(target, normalizedPath);
      return Promise.resolve();
    } catch (error) {
      return this.normalizer.annotateAndReject(error, 'symlink', normalizedPath);
    }
  }
}
