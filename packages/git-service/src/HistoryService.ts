import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';

const logger = {
  warn: (...args: unknown[]): void => console.warn('[WARN] [GitService]', ...args),
  info: (...args: unknown[]): void => console.info('[INFO] [GitService]', ...args),
  error: (...args: unknown[]): void => console.error('[ERROR] [GitService]', ...args),
};

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

export class HistoryService {
  private readonly fs: PromiseFsClient;
  private readonly gitdir: string;
  private cache: object = {};
  private cacheCreatedAt = Date.now();

  constructor(fs: PromiseFsClient, gitdir: string) {
    this.fs = fs;
    this.gitdir = gitdir;
  }

  public clearCache(): void {
    this.cache = {};
    this.cacheCreatedAt = Date.now();
  }

  public ensureFreshCache(ttlSeconds: number): void {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return;
    if (Date.now() - this.cacheCreatedAt > ttlSeconds * 1000) {
      this.clearCache();
    }
  }

  async getLastCommit(branch: string): Promise<git.ReadCommitResult | undefined> {
    try {
      const [commit] = await git.log({
        fs: this.fs,
        gitdir: this.gitdir,
        ref: branch,
        depth: 1,
        cache: this.cache,
      });

      return commit ?? undefined;
    } catch (error) {
      logger.warn(`(get-last-commit) Failed to get last commit for branch ${branch}: ${String(error)}`);
      return undefined;
    }
  }

  async getLog({ ref, depth, filepath }: { ref?: string; depth?: number; filepath?: string }) {
    try {
      const commits = await git.log({
        fs: this.fs,
        gitdir: this.gitdir,
        cache: this.cache,
        ref,
        depth,
        filepath,
      });

      return commits;
    } catch (error) {
      logger.warn(`(get-log) Failed to get log for ref ${ref}: ${String(error)}`);
      return [];
    }
  }

  async getTree(resolvedRef: string, path = '') {
    try {
      const { tree } = await git.readTree({
        fs: this.fs,
        gitdir: this.gitdir,
        oid: resolvedRef,
        filepath: path,
        cache: this.cache,
      });

      return tree;
    } catch (error) {
      logger.error(`(get-tree) Failed to get tree for ${resolvedRef}:${path}: ${String(error)}`);
      return [];
    }
  }

  async getBlob(resolvedRef: string, filepath: string) {
    try {
      const { blob, oid } = await git.readBlob({
        fs: this.fs,
        gitdir: this.gitdir,
        oid: resolvedRef,
        filepath,
        cache: this.cache,
      });
      const isBinary = this.detectBinary(blob);

      return {
        oid,
        content: blob,
        size: blob.length,
        isBinary,
      };
    } catch (error) {
      logger.error(`(get-blob) Failed to get blob for ${resolvedRef}:${filepath}: ${String(error)}`);
      return null;
    }
  }

  getBlobSize(content: Uint8Array): number {
    return content.length;
  }

  detectBinary(content: Uint8Array): boolean {
    const bytesToCheck = Math.min(8000, content.length);
    for (let i = 0; i < bytesToCheck; i += 1) {
      if (content[i] === 0) {
        return true;
      }
    }
    return false;
  }

  async getFileStateChanges(oldCommit: string | undefined, newCommit: string | undefined) {
    type File =
      | {
          isBinary: false;
          content: string;
        }
      | {
          isBinary: true;
          content: null;
        };

    type Change = {
      type: 'add' | 'modify' | 'remove';
      path: string;
      old: File | null;
      new: File | null;
    };

    const data = await git.walk({
      fs: this.fs,
      gitdir: this.gitdir,
      trees: [git.TREE({ ref: oldCommit }), git.TREE({ ref: newCommit })],
      map: async (filepath, [A, B]): Promise<Change | undefined> => {
        if (filepath === '.') {
          return;
        }

        const Atype = A ? await A.type() : null;
        const Btype = B ? await B.type() : null;

        if (Atype === 'tree' || Btype === 'tree') {
          return;
        }

        const Aoid = A ? await A.oid() : null;
        const Boid = B ? await B.oid() : null;

        if (Aoid === null && Boid === null) {
          logger.warn(`(get-file-state-changes): Both A and B are null for path ${filepath}`);
          return;
        }
        const type: 'equal' | 'modify' | 'add' | 'remove' =
          Aoid === null ? 'add' : Boid === null ? 'remove' : Aoid === Boid ? 'equal' : 'modify';

        if (type === 'equal') {
          return;
        }

        const oldContent = await A?.content();
        const newContent = await B?.content();

        const isOldBinary = oldContent && this.detectBinary(oldContent);
        const isNewBinary = newContent && this.detectBinary(newContent);

        let oldFile: File | null = null;

        if (isOldBinary) {
          oldFile = { isBinary: true, content: null };
        } else if (oldContent) {
          oldFile = {
            isBinary: false,
            content: new TextDecoder().decode(oldContent),
          };
        }

        let newFile: File | null = null;

        if (isNewBinary) {
          newFile = { isBinary: true, content: null };
        } else if (newContent) {
          newFile = {
            isBinary: false,
            content: new TextDecoder().decode(newContent),
          };
        }

        return {
          type,
          path: filepath,
          old: oldFile,
          new: newFile,
        };
      },
    });
    return data as Change[];
  }

  async getCommit(commitOid: string) {
    try {
      const commit = await git.readCommit({
        fs: this.fs,
        gitdir: this.gitdir,
        cache: this.cache,
        oid: commitOid,
      });
      if (!commit.commit.parent || commit.commit.parent.length === 0) {
        logger.info(`(get-commit): Commit ${commitOid} is a root commit. Comparing with empty tree.`);
        return {
          commit,
          changes: await this.getFileStateChanges(undefined, commitOid),
        };
      }

      const parentOid = commit.commit.parent[0];
      return {
        commit,
        changes: await this.getFileStateChanges(parentOid, commitOid),
      };
    } catch (error) {
      logger.error(`(get-commit) Failed to get commit changes for ${commitOid}: ${String(error)}`);
      return {
        commit: null,
        changes: [],
      };
    }
  }
}
