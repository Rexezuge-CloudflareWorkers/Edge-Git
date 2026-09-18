/**
 * Repository git read-model types (extracted from `types.ts` god-file).
 * `types.ts` re-exports everything here so existing imports keep working.
 */
export interface BranchesResponse {
  branches: string[];
  currentBranch: string | null;
}

export interface TagInfo {
  name: string;
  ref: string;
  oid: string;
  peeledOid: string | null;
  type: 'lightweight' | 'annotated';
}

export interface GitCommitAuthor {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: number;
}

export interface GitCommit {
  oid: string;
  commit: {
    message: string;
    author: GitCommitAuthor;
    committer: GitCommitAuthor;
    parent: string[];
    tree: string;
  };
  payload: string;
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  oid: string;
  lastCommit: GitCommit | null;
}

export interface BlobResponse {
  oid: string;
  size: number;
  isBinary: boolean;
  contentBase64?: string;
}

export interface OverviewReadme extends BlobResponse {
  path: string;
  truncated?: boolean;
}

export interface OverviewResponse {
  branches: string[];
  currentBranch: string | null;
  resolvedRef: string | null;
  tags: TagInfo[];
  tree: TreeEntry[];
  commits: GitCommit[];
  readme: OverviewReadme | null;
}

export interface FileCommitResult {
  ok: boolean;
  commitOid: string;
  branch?: string;
  path?: string;
  created?: boolean;
  deleted?: boolean;
}

export interface DiffLine {
  kind: 'context' | 'add' | 'remove';
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

export interface FileDiff {
  path: string;
  type: 'add' | 'modify' | 'remove';
  binary: boolean;
  tooLarge: boolean;
  hunks: DiffHunk[];
}

export interface CommitDiffResult {
  commit: GitCommit | null;
  truncated: boolean;
  files: FileDiff[];
}

export interface CompareResult {
  baseOid: string;
  headOid: string;
  mergeBase: string | null;
  truncated: boolean;
  files: FileDiff[];
}
