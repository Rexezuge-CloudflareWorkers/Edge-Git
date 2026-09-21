import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';
import { GitCache } from './GitCache';

const logger = {
  warn: (...args: unknown[]): void => console.warn('[WARN] [GitService]', ...args),
  info: (...args: unknown[]): void => console.info('[INFO] [GitService]', ...args),
  error: (...args: unknown[]): void => console.error('[ERROR] [GitService]', ...args),
};

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

export class ObjectReader {
  private readonly fs: PromiseFsClient;
  private readonly gitdir: string;
  private readonly cacheHolder = new GitCache();

  private get cache(): object {
    return this.cacheHolder.getCache();
  }

  constructor(fs: PromiseFsClient, gitdir: string) {
    this.fs = fs;
    this.gitdir = gitdir;
  }

  public clearCache(): void {
    this.cacheHolder.clearCache();
  }

  public ensureFreshCache(ttlSeconds: number): void {
    this.cacheHolder.ensureFreshCache(ttlSeconds);
  }

  async readObject(oid: string) {
    try {
      return await git.readObject({
        fs: this.fs,
        gitdir: this.gitdir,
        oid,
        cache: this.cache,
      });
    } catch (error) {
      logger.warn(`(read-object) Failed to read object ${oid}: ${String(error)}`);
      return null;
    }
  }

  async readObjectForLsRefs(oid: string) {
    try {
      const result = await git.readObject({
        fs: this.fs,
        gitdir: this.gitdir,
        oid,
        format: 'content',
        cache: this.cache,
      });

      const object = result.object;
      if (typeof object === 'string' || object instanceof Uint8Array) {
        return {
          type: result.type,
          object,
        };
      }

      return {
        type: result.type,
        object: new TextEncoder().encode(JSON.stringify(object)),
      };
    } catch (error) {
      logger.warn(`(read-object-ls-refs) Failed to read object ${oid}: ${String(error)}`);
      return null;
    }
  }

  async expandRef(ref: string) {
    try {
      return await git.expandRef({
        fs: this.fs,
        gitdir: this.gitdir,
        ref,
      });
    } catch {
      return null;
    }
  }

  async peelTag(tagOid: string): Promise<string | null> {
    try {
      const tag = await git.readTag({
        fs: this.fs,
        gitdir: this.gitdir,
        oid: tagOid,
        cache: this.cache,
      });
      return tag.tag.object ?? null;
    } catch {
      return null;
    }
  }

  async hasObject(oid: string): Promise<boolean> {
    try {
      await git.readObject({
        fs: this.fs,
        gitdir: this.gitdir,
        oid,
        cache: this.cache,
      });
      return true;
    } catch {
      return false;
    }
  }
}
