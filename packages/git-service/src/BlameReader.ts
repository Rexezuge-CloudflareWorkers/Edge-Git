import * as git from 'isomorphic-git';
import type { IsoGitFs } from './IsoGitFs';
import type { TreeReader } from './TreeReader';

type PromiseFsClient = ReturnType<IsoGitFs['getPromiseFsClient']>;

type BlameLine = { line: number; commitOid: string; author: string; content: string };

type BlameResult = { oid: string; lines: BlameLine[]; truncated: boolean };

const MAX_BLAME_LINES = 5000;
const MAX_BLAME_COMMITS = 200;
const MAX_BLAME_BYTES = 200_000;

/**
 * Line-attribution reader extracted from `HistoryService.getBlame` (SRP,
 * following the `TreeReader` precedent). Walks file history oldest-first
 * and replays hunks with a position-anchored heuristic; capped to
 * 5000 lines / 200 commits / 200KB. `HistoryService.getBlame` delegates
 * here for backward compatibility.
 */
class BlameReader {
  constructor(
    private readonly fs: PromiseFsClient,
    private readonly gitdir: string,
    private readonly trees: TreeReader,
    private readonly getCache: () => object,
  ) {}

  async blame(
    ref: string,
    filepath: string,
  ): Promise<{
    oid: string;
    lines: Array<{ line: number; commitOid: string; author: string; content: string }>;
    truncated: boolean;
  } | null> {
    let resolved: string | null = null;
    try {
      resolved = await git.resolveRef({ fs: this.fs, gitdir: this.gitdir, ref });
    } catch {
      return null;
    }
    if (!resolved) return null;
    const current = await this.trees.getBlob(resolved, filepath);
    if (!current || (current as { isBinary?: boolean }).isBinary) return null;
    const text = new TextDecoder().decode((current as { content: Uint8Array }).content);
    if (text.length > MAX_BLAME_BYTES) return { oid: resolved, lines: [], truncated: true };
    const currentLines = text.split('\n');
    if (currentLines.length > MAX_BLAME_LINES) return { oid: resolved, lines: [], truncated: true };
    let history: Array<{ oid: string; commit: { author: { name: string; email: string } } }>;
    try {
      history = await git.log({ fs: this.fs, gitdir: this.gitdir, ref, filepath, cache: this.getCache() });
    } catch {
      return null;
    }
    if (history.length === 0) return null;
    // eslint-disable-next-line unicorn/no-array-reverse
    const oldestFirst = [...history].reverse().slice(-MAX_BLAME_COMMITS);
    // Start: all lines belong to the oldest commit touching the file, then
    // walk forward attributing changed lines to newer commits via simple
    // longest-common-subsequence-free heuristic (position-anchored diff).
    const attribution: Array<{ commitOid: string; author: string }> = currentLines.map(() => ({
      commitOid: oldestFirst[0].oid,
      author: oldestFirst[0].commit.author.email || oldestFirst[0].commit.author.name,
    }));
    const fileAt = async (oid: string): Promise<string[] | null> => {
      try {
        const { blob } = await git.readBlob({ fs: this.fs, gitdir: this.gitdir, oid, filepath, cache: this.getCache() });
        if (this.trees.detectBinary(blob)) return null;
        return new TextDecoder().decode(blob).split('\n');
      } catch {
        return null;
      }
    };
    let previous = await fileAt(oldestFirst[0].oid);
    for (const entry of oldestFirst.slice(1)) {
      const next = await fileAt(entry.oid);
      if (!next || !previous) {
        previous = next;
        continue;
      }
      // Lines present in `next` but not at the same position in `previous`
      // are attributed to `entry`; surviving lines keep older attribution.
      // Rebuild attribution anchored to the newest content at the end.
      if (next.length === currentLines.length) {
        for (const [i, line] of next.entries()) {
          if (previous[i] !== line)
            attribution[i] = { commitOid: entry.oid, author: entry.commit.author.email || entry.commit.author.name };
        }
      }
      previous = next;
    }
    // Anchor to current content length (history tip should equal ref).
    const lines = currentLines.map((content, i) => ({
      line: i + 1,
      commitOid: attribution[i]?.commitOid ?? resolved ?? '',
      author: attribution[i]?.author ?? '',
      content,
    }));
    return { oid: resolved, lines, truncated: false };
  }
}

export { BlameReader, MAX_BLAME_LINES, MAX_BLAME_COMMITS, MAX_BLAME_BYTES };
export type { BlameLine, BlameResult };
