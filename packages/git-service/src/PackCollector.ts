import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';
import { GitCache } from './GitCache';
import { PackLimitError, checkObjectBudget, maxVisitedFor } from './PackLimits';
import { parseBlobFilter, shouldSkipBlob as shouldSkipBlobByFilter } from './PackFilter';
import { PackDepthResolver } from './PackDepthResolver';

const logger = {
  warn: (...args: unknown[]): void => console.warn('[WARN] [GitService]', ...args),
  info: (...args: unknown[]): void => console.info('[INFO] [GitService]', ...args),
  error: (...args: unknown[]): void => console.error('[ERROR] [GitService]', ...args),
};

export { PackLimitError } from './PackLimits';

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

export class PackCollector {
  private readonly fs: PromiseFsClient;
  private readonly gitdir: string;
  private readonly cacheHolder = new GitCache();
  private readonly depths: PackDepthResolver;

  private get cache(): object {
    return this.cacheHolder.getCache();
  }

  constructor(fs: PromiseFsClient, gitdir: string) {
    this.fs = fs;
    this.gitdir = gitdir;
    this.depths = new PackDepthResolver(fs, gitdir, () => this.cacheHolder.getCache());
  }

  public clearCache(): void {
    this.cacheHolder.clearCache();
  }

  public ensureFreshCache(ttlSeconds: number): void {
    this.cacheHolder.ensureFreshCache(ttlSeconds);
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
    opts: {
      depth?: number;
      since?: number;
      exclude?: string[];
      filter?: string;
      maxObjects?: number;
      deepenRelative?: boolean;
      relativeTo?: string[];
    } = {},
  ): Promise<{ oids: string[]; shallow: string[] }> {
    const objectsToSend = new Set<string>();
    const visited = new Set<string>();
    const wantSet = new Set(wants);
    const haveSet = new Set(haves);
    const excludeSet = opts.exclude ? new Set(opts.exclude) : new Set<string>();
    const shallowBoundary = new Set<string>();
    const maxDepth = await this.depths.resolveMaxDepth(opts.depth, {
      deepenRelative: opts.deepenRelative,
      relativeTo: opts.relativeTo,
      wants,
      maxObjects: opts.maxObjects,
    });
    const since = opts.since;
    const maxObjects = opts.maxObjects;
    const maxVisited = maxVisitedFor(maxObjects);
    const assertObjectBudget = (): void => {
      checkObjectBudget({ objectsToSend: objectsToSend.size, visited: visited.size, maxObjects, maxVisited });
    };
    const filter = opts.filter?.trim() ?? '';
    const parsedFilter = parseBlobFilter(filter);
    // Fast path: without a blob filter every blob is packed, so the second
    // content read below (size check only) is pure overhead — one extra DO
    // file read per blob. Skip it entirely when no filter applies.
    const hasBlobFilter = parsedFilter.filterBlobs || parsedFilter.blobLimit !== undefined;

    const shouldSkipBlob = (size: number): boolean => shouldSkipBlobByFilter(size, parsedFilter);

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

      if (haveSet.has(oid) || excludeSet.has(oid)) {
        // Depth/since (shallow, deepen, deepen-relative) requests arrive with
        // haves the client physically holds but whose history is truncated at
        // its shallow boundary. Pruning traversal here would cut the depth
        // walk short and return an empty pack with no boundary (breaking
        // `git fetch --deepen`). Traverse through have-commits so the walk
        // still reaches the cutoff — the objects themselves stay excluded.
        // deepen-not exclusions keep pruning: those subtrees are unwanted.
        if ((maxDepth !== undefined || since !== undefined) && haveSet.has(oid)) {
          try {
            const probe = await git.readObject({
              fs: this.fs,
              gitdir: this.gitdir,
              oid,
              cache: this.cache,
            });
            if (probe.type === 'commit') {
              const commit = await git.readCommit({
                fs: this.fs,
                gitdir: this.gitdir,
                oid,
                cache: this.cache,
              });
              for (const parent of commit.commit.parent) {
                queue.push({ oid: parent, depth: depth + 1 });
              }
            }
          } catch {
            // Unreadable have: nothing to traverse through.
          }
        }
        continue;
      }

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

      if (objType === 'blob') {
        if (hasBlobFilter && !wantSet.has(oid)) {
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
            if (shouldSkipBlob(size)) continue;
          } catch {
            // If content read fails, fall through and include the oid.
          }
        }
        objectsToSend.add(oid);
        assertObjectBudget();
        continue;
      }

      if (filter === 'tree:0' && objType === 'tree' && !wantSet.has(oid)) continue;

      objectsToSend.add(oid);
      assertObjectBudget();

      try {
        if (objType === 'commit') {
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
          if (maxDepth !== undefined && depth + 1 >= maxDepth) {
            shallowBoundary.add(oid);
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

  private async enqueueRelatedObjectsWithDepth(
    type: string,
    oid: string,
    queue: Array<{ oid: string; depth: number }>,
    depth: number,
  ): Promise<void> {
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
}
