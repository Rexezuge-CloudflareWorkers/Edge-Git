import type { GitService } from '@edge-git/git-service';
import { mapWithConcurrency } from '@edge-git/shared/utils';

// README candidates at the repo root, mirroring the web CodeTab list so the
// overview response can inline the same file the UI would fetch separately.
const README_NAMES = new Set(['README.md', 'README.markdown', 'README.mdown', 'README.txt', 'README']);

// Upper bound for inlining README bytes into the overview payload. Larger or
// binary READMEs stay null so the aggregate call never becomes a blob pipe;
// the UI can still load them on demand via getBlob.
// BREAKING: reduced 512KB -> 64KB: overview is a hot code-page RPC, base64
// inflates +33%, and large READMEs dominated DO payloads.
const MAX_OVERVIEW_README_BYTES = 64 * 1024;

// Upper bound for unbounded Promise.all fan-out (tag peel, tree last-commit).
// Malicious refs with thousands of tags/entries would otherwise spawn
// thousands of parallel git reads in the DO.
const MAX_FANOUT = 100;
const FANOUT_CONCURRENCY = 10;

// Read-model queries served over DO RPC (branches/tree/blob/commits).
// Lifecycle (ensure initialized, cache refresh) stays with RepoWorker via
// prepare(); this service only runs git queries.
class ReadModelService {
  constructor(private readonly git: GitService) {}

  public async getLatestCommit(branch = 'HEAD'): Promise<unknown> {
    return this.git.getLastCommit(branch);
  }

  public async getCommits(args: { ref?: string; depth?: number; filepath?: string }): Promise<unknown> {
    const latestCommit = (await this.git.getLastCommit(args.ref ?? 'HEAD')) as { oid: string } | null;
    if (!latestCommit) {
      return [];
    }
    // Default 20, cap 50: unbounded log walks read the full history (one
    // commit + tree-diff per entry) and dominate DO rows on large repos.
    const depth = Math.min(Math.max(args.depth ?? 20, 1), 50);
    return this.git.getLog({ ...args, depth });
  }

  public async getBranches(): Promise<{ branches: string[]; currentBranch: string | null }> {
    const [branches, currentBranch] = await Promise.all([this.git.listBranches(), this.git.currentBranch()]);
    return { branches, currentBranch: currentBranch ?? null };
  }

  public async getTags(): Promise<
    Array<{ name: string; ref: string; oid: string; peeledOid: string | null; type: 'lightweight' | 'annotated' }>
  > {
    const tags = await this.git.listTags();
    const capped = tags.slice(0, MAX_FANOUT);
    const enriched = await mapWithConcurrency(capped, FANOUT_CONCURRENCY, async (t) => {
      const name = t.ref.startsWith('refs/tags/') ? t.ref.slice('refs/tags/'.length) : t.ref;
      const peeledOid: string | null = await this.git.peelTag(t.oid);
      const type: 'lightweight' | 'annotated' = peeledOid === null ? 'lightweight' : 'annotated';
      return { name, ref: t.ref, oid: t.oid, peeledOid, type };
    });
    enriched.sort((a, b) => a.name.localeCompare(b.name));
    return enriched;
  }

  public async getTree(args: { ref?: string; path?: string; withLastCommit?: boolean }): Promise<unknown> {
    // Default is cheap (no per-file `getLog`): the code page uses the
    // aggregate `getOverview` fast tree, and explicit `withLastCommit=true`
    // is reserved for on-demand enrichment. Previously the default was true,
    // turning every `/tree` without a flag into up to 100 log walks.
    const { ref, path, withLastCommit = false } = args;
    const resolvedRef = await this.git.resolveRef(ref);
    if (!resolvedRef) {
      return [];
    }
    const tree = await this.git.getTree(resolvedRef, path);
    if (!withLastCommit) {
      return (tree as Array<Record<string, unknown>>).map((item) => ({ ...item, lastCommit: null }));
    }
    const capped = (tree as Array<{ path: string }>).slice(0, MAX_FANOUT);
    const data = await mapWithConcurrency(capped, FANOUT_CONCURRENCY, async (item) => {
      const lastCommit = (await this.git.getLog({
        ref,
        depth: 1,
        filepath: path ? `${path}/${item.path}` : item.path,
      })) as Array<unknown>;
      return { ...item, lastCommit: lastCommit[0] || null };
    });
    return data;
  }

  // Recursive file listing for the code search indexer. Breadth-first walk
  // capped by maxFiles (+ a dir-visit cap) so giant repos cannot blow the
  // DO wall-clock. Returns repo-relative paths with blob oids.
  // Uses an index pointer instead of shift() so the walk stays O(n).
  public async listAllFiles(args: { ref?: string; maxFiles?: number }): Promise<Array<{ path: string; oid: string }>> {
    const maxFiles = Math.min(Math.max(args.maxFiles ?? 200, 1), 500);
    const resolvedRef = await this.git.resolveRef(args.ref);
    if (!resolvedRef) return [];
    const files: Array<{ path: string; oid: string }> = [];
    const queue: string[] = [''];
    let head = 0;
    let dirsVisited = 0;
    while (head < queue.length && files.length < maxFiles && dirsVisited < 200) {
      const dir = queue.at(head);
      head += 1;
      if (dir === undefined) break;
      dirsVisited += 1;
      const entries = await this.readTreeEntries(resolvedRef, dir);
      ReadModelService.collectEntries(entries, dir, queue, files, maxFiles);
    }
    return files;
  }

  private async readTreeEntries(resolvedRef: string, dir: string): Promise<Array<{ path: string; type: string; oid: string }>> {
    try {
      return await this.git.getTree(resolvedRef, dir);
    } catch {
      return [];
    }
  }

  private static collectEntries(
    entries: Array<{ path: string; type: string; oid: string }>,
    dir: string,
    queue: string[],
    files: Array<{ path: string; oid: string }>,
    maxFiles: number,
  ): void {
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const fullPath = dir ? `${dir}/${entry.path}` : entry.path;
      if (entry.type === 'tree') {
        queue.push(fullPath);
      } else if (entry.type === 'blob') {
        files.push({ path: fullPath, oid: entry.oid });
      }
    }
  }

  public async getBlob(args: { ref?: string; filepath: string }): Promise<unknown> {
    const { ref, filepath } = args;
    const resolvedRef = await this.git.resolveRef(ref);
    if (!resolvedRef) {
      return null;
    }
    const blob = await this.git.getBlob(resolvedRef, filepath);
    if (!blob) return null;
    return ReadModelService.serializeBlob(blob);
  }

  /**
   * Resolve the overview's read ref: explicit `ref` (exact, no fallback),
   * else HEAD with fallback to the current branch name and then the first
   * branch so a repo whose HEAD dangles still reports its real content.
   */
  private async resolveOverviewRef(
    ref: string | undefined,
    branches: string[],
    currentBranch: string | null,
  ): Promise<{ oid: string | null; refForLog: string }> {
    const head = ref ?? 'HEAD';
    const oid = await this.git.resolveRef(head);
    if (oid || ref) return { oid, refForLog: head };
    const candidates: string[] = [];
    if (currentBranch) candidates.push(`refs/heads/${currentBranch}`);
    for (const branch of branches) {
      const candidate = `refs/heads/${branch}`;
      if (!candidates.includes(candidate)) candidates.push(candidate);
    }
    for (const candidate of candidates) {
      const fallbackOid = await this.git.resolveRef(candidate);
      if (fallbackOid) return { oid: fallbackOid, refForLog: candidate };
    }
    return { oid: null, refForLog: 'HEAD' };
  }

  /**
   * Aggregate read for the repo code page: branches + tags + fast tree
   * (no per-file last-commit) + recent commits + root README, sharing one
   * ref resolution. Replaces 5 sequential DO RPCs (branches, tags,
   * tree?withLastCommit=0, commits, blob) with a single RPC so the DO input
   * gate is paid once instead of per call.
   */
  public async getOverview(args: { ref?: string; path?: string; depth?: number; includeTags?: boolean; includeReadme?: boolean }): Promise<{
    branches: string[];
    currentBranch: string | null;
    resolvedRef: string | null;
    tags: Array<{ name: string; ref: string; oid: string; peeledOid: string | null; type: 'lightweight' | 'annotated' }>;
    tree: unknown;
    commits: unknown;
    readme: ({ path: string } & Record<string, unknown>) | null;
  }> {
    const ref = args.ref || undefined;
    const dir = args.path || '';
    // Default 5, cap 20: each log entry costs a commit read + tree walk in
    // the DO (SQLite rows). Deeper history paginates via explicit depth.
    const depth = Math.min(Math.max(args.depth ?? 5, 1), 20);
    // Parallelize independent reads (was 3 sequential round-trips).
    const [branches, currentBranch, tags] = await Promise.all([
      this.git.listBranches(),
      this.git.currentBranch().then((b) => b ?? null),
      args.includeTags === false ? Promise.resolve([]) : this.getTags(),
    ]);
    // Default reads follow HEAD, but a fresh repo's HEAD can dangle (init
    // defaults to `main` while the first push landed on another branch, e.g.
    // `master`). An explicit `ref` keeps exact semantics (no fallback).
    const resolved = await this.resolveOverviewRef(ref, branches, currentBranch);
    if (!resolved.oid) {
      return { branches, currentBranch, resolvedRef: null, tags, tree: [], commits: [], readme: null };
    }
    const { oid: resolvedRef, refForLog } = resolved;
    const rawTree = (await this.git.getTree(resolvedRef, dir)) as Array<{
      path: string;
      type: string;
      mode?: string;
      oid: string;
    }>;
    const tree = rawTree.map((item) => ({ ...item, lastCommit: null }));
    const latestCommit = (await this.git.getLastCommit(refForLog)) as { oid: string } | null | undefined;
    const commits = latestCommit ? await this.git.getLog({ ref: refForLog, depth }) : [];
    let readme: ({ path: string } & Record<string, unknown>) | null = null;
    if (dir === '' && args.includeReadme !== false) {
      const entry = rawTree.find((item) => item.type === 'blob' && README_NAMES.has(item.path));
      if (entry) {
        const blob = await this.git.getBlob(resolvedRef, entry.path);
        if (blob && typeof (blob as { size?: number }).size === 'number' && (blob as { size: number }).size <= MAX_OVERVIEW_README_BYTES) {
          readme = { path: entry.path, ...(ReadModelService.serializeBlob(blob) as Record<string, unknown>) };
        } else if (blob) {
          // Oversized README: return metadata without bytes so the UI can
          // fall back to an on-demand blob fetch instead of a huge payload.
          const meta = { ...(blob as Record<string, unknown>) };
          delete meta.content;
          readme = { path: entry.path, ...meta, contentBase64: undefined, truncated: true };
        }
      }
    }
    return { branches, currentBranch, resolvedRef, tags, tree, commits, readme };
  }

  private static serializeBlob(blob: object): unknown {
    // Serialize Uint8Array safely as base64
    const content = (blob as { content?: Uint8Array }).content;
    if (content instanceof Uint8Array) {
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < content.length; i += chunk) {
        binary += String.fromCodePoint(...content.subarray(i, i + chunk));
      }
      return { ...blob, contentBase64: btoa(binary) };
    }
    return blob;
  }

  public async getCommit(commitOid: string): Promise<unknown> {
    return this.git.getCommit(commitOid);
  }

  public async getCommitDiff(commitOid: string, maxFiles: number): Promise<unknown> {
    return this.git.getCommitDiff(commitOid, maxFiles);
  }

  public async getCompare(baseRef: string, headRef: string, maxFiles: number): Promise<unknown> {
    return this.git.getCompareDiff(baseRef, headRef, maxFiles);
  }

  public async getMergePreview(baseRef: string, headRef: string): Promise<unknown> {
    return this.git.getMergePreview(baseRef, headRef);
  }

  public async getMergePreviewByOids(baseOid: string, headOid: string): Promise<unknown> {
    return this.git.getMergePreviewByOids(baseOid, headOid);
  }

  public async getPullDiff(baseOid: string | null, headOid: string, maxFiles: number): Promise<unknown> {
    if (!baseOid) {
      const commit = (await this.git.getCommit(headOid)) as { changes?: unknown } | null;
      const changes = Array.isArray((commit as { changes?: unknown })?.changes) ? (commit as { changes: unknown[] }).changes : [];
      return { mergeBase: null, truncated: changes.length > maxFiles, changes: changes.slice(0, maxFiles) };
    }
    const mergeBase = await this.git.findMergeBase([baseOid, headOid]);
    const diffBase = mergeBase ?? baseOid;
    const changes = (await this.git.getFileStateChanges(diffBase, headOid)) as unknown[];
    return { mergeBase, truncated: changes.length > maxFiles, changes: changes.slice(0, maxFiles) };
  }

  public async getBlame(ref: string, filepath: string): Promise<unknown> {
    return this.git.getBlame(ref, filepath);
  }
}

export { ReadModelService };
