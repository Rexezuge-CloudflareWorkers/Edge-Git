import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';
import { GitCache } from './GitCache';
import { PackLimitError, checkObjectBudget, maxVisitedFor } from './PackLimits';

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
    const maxDepth = await this.resolveMaxDepth(opts.depth, {
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
    const filterBlobs = filter === 'blob:none';
    const blobLimitMatch = /^blob:limit=(\d+)$/.exec(filter);
    const blobLimit = blobLimitMatch ? Math.trunc(Number(blobLimitMatch[1])) : undefined;

    const shouldSkipBlob = (size: number): boolean => {
      if (filterBlobs) return true;
      if (blobLimit !== undefined && Number.isFinite(blobLimit)) return size > blobLimit;
      return false;
    };

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

  // deepen-relative: measure the client shallow boundary's depth from the
  // tips and extend the cutoff by the requested depth. Falls back to the
  // absolute depth when the boundary is not reachable from the wants.
  private async resolveMaxDepth(
    depth: number | undefined,
    opts: { deepenRelative?: boolean; relativeTo?: string[]; wants: string[]; maxObjects?: number },
  ): Promise<number | undefined> {
    if (depth === undefined || !opts.deepenRelative || !opts.relativeTo || opts.relativeTo.length === 0) {
      return depth;
    }
    const targets = new Set(opts.relativeTo);
    const depths = await this.measureCommitDepths(opts.wants, targets, (opts.maxObjects ?? 10_000) * 4 + 1000);
    let deepest = -1;
    for (const target of targets) {
      const found = depths.get(target);
      if (found !== undefined && found > deepest) deepest = found;
    }
    if (deepest < 0) {
      logger.warn('(collect-objects) deepen-relative boundary unreachable; using absolute depth');
      return depth;
    }
    return deepest + depth + 1;
  }

  // BFS over commit parents from `starts`; returns tip-relative depths for
  // the reachable subset of `targets`.
  private async measureCommitDepths(starts: string[], targets: Set<string>, budget: number): Promise<Map<string, number>> {
    const depths = new Map<string, number>();
    const visited = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = starts.map((oid) => ({ oid, depth: 0 }));
    while (queue.length > 0 && depths.size < targets.size && visited.size < budget) {
      const item = queue.shift();
      if (!item || visited.has(item.oid)) continue;
      visited.add(item.oid);
      if (targets.has(item.oid)) depths.set(item.oid, item.depth);
      try {
        const commit = await git.readCommit({ fs: this.fs, gitdir: this.gitdir, oid: item.oid, cache: this.cache });
        for (const parent of commit.commit.parent) {
          if (!visited.has(parent)) queue.push({ oid: parent, depth: item.depth + 1 });
        }
      } catch {
        // Non-commit wants (tags/trees) have no parents to measure through.
      }
    }
    return depths;
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
