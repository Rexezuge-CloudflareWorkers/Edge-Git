import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

const logger = {
  warn: (...args: unknown[]): void => console.warn('[WARN] [GitService]', ...args),
};

interface DepthResolveOptions {
  deepenRelative?: boolean;
  relativeTo?: string[];
  wants: string[];
  maxObjects?: number;
}

/**
 * Shallow-depth resolver extracted from `PackCollector` (SRP). Owns the
 * `deepen-relative` boundary measurement (BFS over commit parents) so
 * `PackCollector.collectObjectsForPack` keeps only the object walk.
 * `PackCollector` delegates via `resolveMaxDepth`.
 */
class PackDepthResolver {
  constructor(
    private readonly fs: PromiseFsClient,
    private readonly gitdir: string,
    private readonly getCache: () => object,
  ) {}

  // deepen-relative: measure the client shallow boundary's depth from the
  // tips and extend the cutoff by the requested depth. Falls back to the
  // absolute depth when the boundary is not reachable from the wants.
  async resolveMaxDepth(depth: number | undefined, opts: DepthResolveOptions): Promise<number | undefined> {
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
  async measureCommitDepths(starts: string[], targets: Set<string>, budget: number): Promise<Map<string, number>> {
    const depths = new Map<string, number>();
    const visited = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = starts.map((oid) => ({ oid, depth: 0 }));
    while (queue.length > 0 && depths.size < targets.size && visited.size < budget) {
      const item = queue.shift();
      if (!item || visited.has(item.oid)) continue;
      visited.add(item.oid);
      if (targets.has(item.oid)) depths.set(item.oid, item.depth);
      try {
        const commit = await git.readCommit({ fs: this.fs, gitdir: this.gitdir, oid: item.oid, cache: this.getCache() });
        for (const parent of commit.commit.parent) {
          if (!visited.has(parent)) queue.push({ oid: parent, depth: item.depth + 1 });
        }
      } catch {
        // Non-commit wants (tags/trees) have no parents to measure through.
      }
    }
    return depths;
  }
}

export { PackDepthResolver };
export type { DepthResolveOptions };
