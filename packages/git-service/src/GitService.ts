import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';
import type { RefUpdateResult } from '@edge-git/git-protocol';

const logger = {
  warn: (...args: unknown[]): void => console.warn('[WARN] [GitService]', ...args),
  info: (...args: unknown[]): void => console.info('[INFO] [GitService]', ...args),
  error: (...args: unknown[]): void => console.error('[ERROR] [GitService]', ...args),
};

export class PackLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackLimitError';
  }
}

export class GitService {
  private readonly fs: ReturnType<IsoGitFs['getPromiseFsClient']>;
  private readonly gitdir: string;

  private cache: object = {};
  private cacheCreatedAt = Date.now();

  constructor(fs: ReturnType<IsoGitFs['getPromiseFsClient']>, gitdir: string) {
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

  async initRepo() {
    await git.init({
      fs: this.fs,
      dir: this.gitdir,
      bare: true,
      defaultBranch: 'main',
    });
  }

  async listRefs() {
    let symbolicHead: string | null = null;
    const refs: Array<{ ref: string; oid: string }> = [];

    try {
      const headContent = await this.fs.promises.readFile('/repo/HEAD', {
        encoding: 'utf8',
      });
      const headStr = typeof headContent === 'string' ? headContent : new TextDecoder().decode(headContent);
      const match = /^ref:\s*(\S.*)$/.exec(headStr.trim());
      if (match) {
        symbolicHead = match[1]; // e.g., "refs/heads/main"
      }
    } catch {
      logger.warn('(read-head-file) No HEAD found in repository.');
    }

    try {
      const headOid = await git.resolveRef({
        fs: this.fs,
        gitdir: this.gitdir,
        ref: 'HEAD',
      });
      refs.push({ ref: 'HEAD', oid: headOid });
    } catch {
      logger.warn('(resolve-head-ref) No HEAD ref found in repository.');
    }

    const [branches, tags] = await Promise.all([this.listBranchesWithOid(), this.listTags()]);

    refs.push(...branches, ...tags);

    return { refs, symbolicHead };
  }

  async listBranchesWithOid(): Promise<Array<{ ref: string; oid: string }>> {
    try {
      const branchRefs = await git.listBranches({
        fs: this.fs,
        gitdir: this.gitdir,
      });
      const branches = await Promise.all(
        branchRefs.map(async (branch) => {
          const oid = await git.resolveRef({
            fs: this.fs,
            gitdir: this.gitdir,
            ref: `refs/heads/${branch}`,
          });
          return { ref: `refs/heads/${branch}`, oid };
        }),
      );
      return branches;
    } catch {
      return [];
    }
  }

  async listBranches() {
    try {
      const branchRefs = await git.listBranches({
        fs: this.fs,
        gitdir: this.gitdir,
      });
      return branchRefs;
    } catch (error) {
      logger.warn('(list-branches) Failed to list branches: ', error);
      return [];
    }
  }

  async currentBranch() {
    try {
      const branch = await git.currentBranch({
        fs: this.fs,
        gitdir: this.gitdir,
        fullname: false,
      });
      return branch ?? null;
    } catch (error) {
      logger.warn('(current-branch) Failed to get current branch: ', error);
      return null;
    }
  }

  async listTags(): Promise<Array<{ ref: string; oid: string }>> {
    try {
      const tagRefs = await git.listTags({
        fs: this.fs,
        gitdir: this.gitdir,
      });
      const tags = await Promise.all(
        tagRefs.map(async (tag) => {
          const oid = await git.resolveRef({
            fs: this.fs,
            gitdir: this.gitdir,
            ref: `refs/tags/${tag}`,
          });
          return { ref: `refs/tags/${tag}`, oid };
        }),
      );
      return tags;
    } catch {
      return [];
    }
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

      // Ensure we return string or Uint8Array
      const object = result.object;
      if (typeof object === 'string' || object instanceof Uint8Array) {
        return {
          type: result.type,
          object,
        };
      }

      // If it's a parsed object, we need to serialize it
      // This shouldn't happen with format: "content", but handle it just in case
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

  async indexPack(filePath: string) {
    await git.indexPack({
      fs: this.fs,
      dir: this.gitdir,
      gitdir: this.gitdir,
      filepath: filePath,
      cache: this.cache,
    });
  }

  async collectObjectsForPack(
    wants: string[],
    haves: string[],
    opts: { depth?: number; since?: number; exclude?: string[]; filter?: string; maxObjects?: number } = {},
  ): Promise<{ oids: string[]; shallow: string[] }> {
    const objectsToSend = new Set<string>();
    const visited = new Set<string>();
    const wantSet = new Set(wants);
    const haveSet = new Set(haves);
    const excludeSet = opts.exclude ? new Set(opts.exclude) : new Set<string>();
    const shallowBoundary = new Set<string>();
    const maxDepth = opts.depth;
    const since = opts.since;
    const maxObjects = opts.maxObjects;
    const maxVisited = (maxObjects ?? 10_000) * 4 + 1000;
    const assertObjectBudget = (): void => {
      if (maxObjects !== undefined && objectsToSend.size > maxObjects) {
        throw new PackLimitError(`too many objects: limit is ${maxObjects}`);
      }
      if (visited.size > maxVisited || objectsToSend.size > maxVisited) {
        throw new PackLimitError('rev-walk too large');
      }
    };
    const filter = opts.filter?.trim() ?? '';
    const filterBlobs = filter === 'blob:none';
    const blobLimitMatch = /^blob:limit=(\d+)$/.exec(filter);
    const blobLimit = blobLimitMatch ? Math.trunc(Number(blobLimitMatch[1])) : undefined;

    const shouldSkipBlob = (size: number): boolean => {
      if (filterBlobs) return true;
      if (blobLimit !== undefined && Number.isFinite(blobLimit)) return size > blobLimit;
      return false;
    };

    // BFS queue with depth tracking for shallow/deepen support.
    // Depth 0 = want tips; parents increment depth. Trees/blobs inherit commit depth.
    const queue: Array<{ oid: string; depth: number }> = wants.map((oid) => ({ oid, depth: 0 }));

    while (queue.length > 0) {
      if (queue.length > maxVisited) {
        throw new PackLimitError('rev-walk too large');
      }
      const item = queue.shift();
      if (!item) continue;
      const { oid, depth } = item;
      if (!oid || visited.has(oid)) continue;

      visited.add(oid);
      assertObjectBudget();

      // If the client already has this object (or it's explicitly excluded via
      // deepen-not), don't include it or traverse further.
      if (haveSet.has(oid) || excludeSet.has(oid)) continue;

      let objType: string;
      try {
        const read = await git.readObject({
          fs: this.fs,
          gitdir: this.gitdir,
          oid,
          cache: this.cache,
        });
        objType = read.type;
      } catch (error) {
        logger.error(`(collect-objects) Failed to read object ${oid}: ${String(error)}`);
        continue;
      }

      // Filter support: blob:none / blob:limit=N skip blob payloads, except for
      // explicitly wanted objects (promisor lazy-fetch names blobs directly).
      if (objType === 'blob') {
        try {
          const obj = await git.readObject({
            fs: this.fs,
            gitdir: this.gitdir,
            oid,
            format: 'content',
            cache: this.cache,
          });
          const content = obj.object;
          const size = typeof content === 'string' ? content.length : (content as Uint8Array).length;
          if (shouldSkipBlob(size) && !wantSet.has(oid)) continue;
        } catch {
          // If content read fails, fall through and include the oid.
        }
        objectsToSend.add(oid);
        assertObjectBudget();
        continue;
      }

      // tree:0 filter drops trees and blobs but keeps commits/tags, except for
      // explicitly wanted objects.
      if (filter === 'tree:0' && objType === 'tree' && !wantSet.has(oid)) continue;

      // Add this object to the set of objects to send
      objectsToSend.add(oid);
      assertObjectBudget();

      try {
        if (objType === 'commit') {
          // deepen-since: stop descending into parents older than the cutoff.
          if (since !== undefined) {
            const commit = await git.readCommit({
              fs: this.fs,
              gitdir: this.gitdir,
              oid,
              cache: this.cache,
            });
            const timestamp = commit.commit.committer.timestamp ?? commit.commit.author.timestamp;
            if (timestamp < since) {
              shallowBoundary.add(oid);
              continue;
            }
          }
          // deepen: truncate parent traversal at maxDepth (N commits from each tip:
          // a tip at depth d expands parents only while d + 1 < maxDepth).
          if (maxDepth !== undefined && depth + 1 >= maxDepth) {
            shallowBoundary.add(oid);
            // Still include this commit's tree (shallow boundary keeps its tree).
            const commit = await git.readCommit({
              fs: this.fs,
              gitdir: this.gitdir,
              oid,
              cache: this.cache,
            });
            queue.push({ oid: commit.commit.tree, depth: depth + 1 });
            continue;
          }
        }
        await this.enqueueRelatedObjectsWithDepth(objType, oid, queue, depth);
      } catch (error) {
        logger.error(`(collect-objects) Failed to expand object ${oid}: ${String(error)}`);
      }
    }

    return { oids: Array.from(objectsToSend), shallow: Array.from(shallowBoundary) };
  }

  private async enqueueRelatedObjectsWithDepth(type: string, oid: string, queue: Array<{ oid: string; depth: number }>, depth: number): Promise<void> {
    switch (type) {
      case 'commit': {
        const commit = await git.readCommit({
          fs: this.fs,
          gitdir: this.gitdir,
          oid,
          cache: this.cache,
        });
        queue.push({ oid: commit.commit.tree, depth: depth + 1 });
        for (const parent of commit.commit.parent) {
          queue.push({ oid: parent, depth: depth + 1 });
        }
        break;
      }
      case 'tree': {
        const tree = await git.readTree({
          fs: this.fs,
          gitdir: this.gitdir,
          oid,
          cache: this.cache,
        });
        for (const entry of tree.tree) {
          queue.push({ oid: entry.oid, depth: depth + 1 });
        }
        break;
      }
      case 'tag': {
        const tag = await git.readTag({
          fs: this.fs,
          gitdir: this.gitdir,
          oid,
          cache: this.cache,
        });
        queue.push({ oid: tag.tag.object, depth: depth + 1 });
        break;
      }
      default: {
        break;
      }
    }
  }

  async packObjects(oids: string[]) {
    const result = await git.packObjects({
      fs: this.fs,
      dir: this.gitdir,
      gitdir: this.gitdir,
      oids,
      write: false,
      cache: this.cache,
    });

    return result.packfile;
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

  async findCommonCommits(haves: string[], maxHaves?: number): Promise<string[]> {
    if (maxHaves !== undefined && haves.length > maxHaves) {
      throw new PackLimitError(`too many haves: ${haves.length} > ${maxHaves}`);
    }
    const common: string[] = [];

    for (const oid of haves) {
      const hasObject = await this.hasObject(oid);
      if (hasObject) {
        common.push(oid);
      }
    }

    return common;
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

  async resolveRef(ref = 'HEAD') {
    try {
      const oid = await git.resolveRef({
        fs: this.fs,
        gitdir: this.gitdir,
        ref,
      });
      return oid;
    } catch (error) {
      logger.warn(`(resolve-ref) Failed to resolve ref ${ref}: ${String(error)}`);
      return null;
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
    // Check first 8000 bytes for null bytes (common binary file indicator)
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

    // Use git.walk to compare the trees of the two commits
    const data = await git.walk({
      fs: this.fs,
      gitdir: this.gitdir,
      trees: [git.TREE({ ref: oldCommit }), git.TREE({ ref: newCommit })],
      map: async (filepath, [A, B]): Promise<Change | undefined> => {
        // ignore directories
        if (filepath === '.') {
          return;
        }

        // A and B are "TreeEntry" objects.
        // We need to check their type (blob or tree)
        const Atype = A ? await A.type() : null;
        const Btype = B ? await B.type() : null;

        if (Atype === 'tree' || Btype === 'tree') {
          return;
        }

        // generate oids (object IDs)
        const Aoid = A ? await A.oid() : null;
        const Boid = B ? await B.oid() : null;

        // determine modification type
        if (Aoid === null && Boid === null) {
          logger.warn(`(get-file-state-changes): Both A and B are null for path ${filepath}`);
          return; // Should not happen
        }
        const type: 'equal' | 'modify' | 'add' | 'remove' =
          Aoid === null ? 'add' : Boid === null ? 'remove' : Aoid === Boid ? 'equal' : 'modify';

        // Don't return 'equal' files
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

  // Ref update validation + application (atomic opt-in).
  async applyRefUpdates(commands: Array<{ oldOid: string; newOid: string; ref: string }>, atomic: boolean): Promise<RefUpdateResult[]> {
    const results: RefUpdateResult[] = [];
    const ZERO_OID = '0'.repeat(40);

    // Validate all commands first
    for (const cmd of commands) {
      const isDelete = cmd.newOid === ZERO_OID;
      const isCreate = cmd.oldOid === ZERO_OID;

      try {
        let currentOid: string | null = null;
        try {
          currentOid = await git.resolveRef({
            fs: this.fs,
            gitdir: '/repo',
            ref: cmd.ref,
          });
        } catch {
          logger.info(`(apply-ref-updates): Ref ${cmd.ref} does not exist.`);
        }

        // Validate old OID matches current
        if (currentOid && cmd.oldOid !== ZERO_OID && currentOid !== cmd.oldOid) {
          results.push({
            ref: cmd.ref,
            ok: false,
            error: 'ref update rejected: old OID mismatch',
          });
          continue;
        }

        if (isDelete) {
          // Delete ref
          if (currentOid) {
            results.push({ ref: cmd.ref, ok: true });
          } else {
            results.push({
              ref: cmd.ref,
              ok: false,
              error: "ref doesn't exist",
            });
          }
        } else if (isCreate) {
          // Create new ref
          if (currentOid) {
            results.push({
              ref: cmd.ref,
              ok: false,
              error: 'ref already exists',
            });
          } else {
            results.push({ ref: cmd.ref, ok: true });
          }
        } else {
          // Update existing ref - check fast-forward
          if (!currentOid) {
            results.push({
              ref: cmd.ref,
              ok: false,
              error: "ref doesn't exist",
            });
            continue;
          }

          const isFF = await git.isDescendent({
            fs: this.fs,
            gitdir: '/repo',
            oid: cmd.newOid,
            ancestor: currentOid,
          });

          if (isFF) {
            results.push({ ref: cmd.ref, ok: true });
          } else {
            results.push({
              ref: cmd.ref,
              ok: false,
              error: 'non-fast-forward update rejected',
            });
          }
        }
      } catch (error) {
        results.push({
          ref: cmd.ref,
          ok: false,
          error: (error as Error).message,
        });
      }
    }

    // If atomic and any failed, fail all
    if (atomic && results.some((r) => !r.ok)) {
      return results.map((r) => ({
        ...r,
        ok: false,
        error: r.error || 'atomic transaction failed',
      }));
    }

    // Apply successful updates
    for (const [i, cmd] of commands.entries()) {
      if (!results[i].ok) continue;

      const isDelete = cmd.newOid === ZERO_OID;

      try {
        if (isDelete) {
          await git.deleteRef({
            fs: this.fs,
            gitdir: '/repo',
            ref: cmd.ref,
          });
        } else {
          await git.writeRef({
            fs: this.fs,
            gitdir: '/repo',
            ref: cmd.ref,
            value: cmd.newOid,
            force: true,
          });
        }
      } catch (error) {
        results[i] = {
          ref: cmd.ref,
          ok: false,
          error: `failed to update: ${(error as Error).message}`,
        };
      }
    }

    return results;
  }
}
