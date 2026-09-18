import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

const logger = {
  error: (...args: unknown[]): void => console.error('[ERROR] [GitService]', ...args),
};

/**
 * Tree/blob reads extracted from `HistoryService` (SRP). Owns `readTree` /
 * `readBlob` + binary detection; history (log/blame/diff) stays in
 * `HistoryService`, which delegates here for backward compatibility.
 */
class TreeReader {
  constructor(
    private readonly fs: PromiseFsClient,
    private readonly gitdir: string,
    private readonly cache: () => object,
  ) {}

  public async getTree(resolvedRef: string, path = '') {
    try {
      const { tree } = await git.readTree({
        fs: this.fs,
        gitdir: this.gitdir,
        oid: resolvedRef,
        filepath: path,
        cache: this.cache(),
      });
      return tree;
    } catch (error) {
      logger.error(`(get-tree) Failed to get tree for ${resolvedRef}:${path}: ${String(error)}`);
      return [];
    }
  }

  public async getBlob(resolvedRef: string, filepath: string) {
    try {
      const { blob, oid } = await git.readBlob({
        fs: this.fs,
        gitdir: this.gitdir,
        oid: resolvedRef,
        filepath,
        cache: this.cache(),
      });
      const isBinary = this.detectBinary(blob);
      return { oid, content: blob, size: blob.length, isBinary };
    } catch (error) {
      logger.error(`(get-blob) Failed to get blob for ${resolvedRef}:${filepath}: ${String(error)}`);
      return null;
    }
  }

  public getBlobSize(content: Uint8Array): number {
    return content.length;
  }

  public detectBinary(content: Uint8Array): boolean {
    const bytesToCheck = Math.min(8000, content.length);
    for (let i = 0; i < bytesToCheck; i += 1) {
      if (content[i] === 0) return true;
    }
    return false;
  }
}

export { TreeReader };
