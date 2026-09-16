// Pure line-diff utilities (Myers O(ND) + unified hunks). No I/O, no git
// dependency — safe to use from workers and unit tests.

export type DiffLineKind = 'context' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export const DIFF_CONTEXT_LINES = 3;
export const MAX_DIFF_LINES_PER_FILE = 4000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

type Op = { kind: 'equal' | 'delete' | 'insert'; a: number; b: number };

// One Myers forward pass for depth `d`; returns true once (N, M) is reached.
function stepDepth(a: string[], b: string[], v: number[], d: number, offset: number): boolean {
  const N = a.length;
  const M = b.length;
  for (let k = -d; k <= d; k += 2) {
    const idx = k + offset;
    const x = k === -d || (k !== d && v[idx - 1] < v[idx + 1]) ? v[idx + 1] : v[idx - 1] + 1;
    let furthest = x;
    let y = furthest - k;
    while (furthest < N && y < M && a[furthest] === b[y]) {
      furthest++;
      y++;
    }
    v[idx] = furthest;
    if (furthest >= N && y >= M) return true;
  }
  return false;
}

// Walk the recorded frontier back to (0, 0), emitting the edit script.
function backtrack(trace: number[][], N: number, M: number, offset: number): Op[] {
  const ops: Op[] = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d >= 1; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    const idx = k + offset;
    const prevK = k === -d || (k !== d && prev[idx - 1] < prev[idx + 1]) ? k + 1 : k - 1;
    const prevX = prev[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'equal', a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (prevK === k + 1) {
      ops.push({ kind: 'insert', a: x, b: y - 1 });
      y--;
    } else {
      ops.push({ kind: 'delete', a: x - 1, b: y });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: 'equal', a: x - 1, b: y - 1 });
    x--;
    y--;
  }
  ops.reverse();
  return ops;
}

// Myers greedy LCS edit script over line indices into `a`/`b`.
function myers(a: string[], b: string[]): Op[] {
  const max = a.length + b.length;
  const offset = max;
  const v: number[] = Array.from({ length: 2 * max + 1 }, () => -1);
  v[offset + 1] = 0;
  const trace: number[][] = [];
  for (let d = 0; d <= max; d++) {
    const reached = stepDepth(a, b, v, d, offset);
    trace.push(v.slice());
    if (reached) break;
  }
  return backtrack(trace, a.length, b.length, offset);
}

function nextChange(changed: boolean[], from: number): number {
  const rel = changed.slice(from).findIndex(Boolean);
  return rel === -1 ? -1 : from + rel;
}

// End offset (exclusive) of the hunk starting at `start`, merging change
// regions whose context windows overlap.
function findHunkEnd(ops: Op[], changed: boolean[], start: number, context: number): number {
  let end = start + 1;
  let nxt = nextChange(changed, end);
  while (nxt !== -1 && nxt - end <= 2 * context) {
    end = nxt + 1;
    nxt = nextChange(changed, end);
  }
  end = Math.min(ops.length, end + context);
  nxt = nextChange(changed, end);
  while (nxt !== -1 && nxt < end + context) {
    end = Math.min(ops.length, nxt + 1 + context);
    nxt = nextChange(changed, end);
  }
  return end;
}

function buildHunkLines(ops: Op[], a: string[], b: string[], start: number, end: number): DiffLine[] {
  let oldNo = ops.slice(0, start).filter((op) => op.kind !== 'insert').length;
  let newNo = ops.slice(0, start).filter((op) => op.kind !== 'delete').length;
  return ops.slice(start, end).map((op): DiffLine => {
    if (op.kind === 'equal') {
      oldNo++;
      newNo++;
      return { kind: 'context', text: a[op.a], oldNo, newNo };
    }
    if (op.kind === 'delete') {
      oldNo++;
      return { kind: 'remove', text: a[op.a], oldNo, newNo: null };
    }
    newNo++;
    return { kind: 'add', text: b[op.b], oldNo: null, newNo };
  });
}

// Group an edit script into unified hunks with `context` lines of context.
// Change regions whose expanded windows overlap are merged.
export function computeHunks(oldText: string, newText: string, context = DIFF_CONTEXT_LINES): DiffHunk[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = myers(a, b);
  const changed = ops.map((op) => op.kind !== 'equal');
  const hunks: DiffHunk[] = [];
  let i = nextChange(changed, 0);
  while (i !== -1) {
    const begin = Math.max(0, i - context);
    const end = findHunkEnd(ops, changed, i, context);
    const lines = buildHunkLines(ops, a, b, begin, end);
    const first = lines[0];
    const oldStart = first.oldNo ?? first.newNo ?? 1;
    const newStart = lines.find((l) => l.newNo !== null)?.newNo ?? oldStart;
    hunks.push({
      oldStart,
      oldLines: lines.filter((l) => l.kind !== 'add').length,
      newStart,
      newLines: lines.filter((l) => l.kind !== 'remove').length,
      lines,
    });
    i = nextChange(changed, end);
  }
  return hunks;
}

export function diffText(oldText: string | null, newText: string | null): { tooLarge: boolean; hunks: DiffHunk[] } {
  const a = splitLines(oldText ?? '');
  const b = splitLines(newText ?? '');
  if (a.length + b.length > MAX_DIFF_LINES_PER_FILE) {
    return { tooLarge: true, hunks: [] };
  }
  return { tooLarge: false, hunks: computeHunks(oldText ?? '', newText ?? '') };
}
