export { IsoGitFs } from './IsoGitFs';
export { GitCache } from './GitCache';
export { createDofsFs, setDofsDeviceSize, DEFAULT_CHUNK_SIZE } from './DofsFsAdapter';
export type { DofsFs, DofsFsOptions } from './DofsFsAdapter';
export { ErrorNormalizer, ErrorWithCode, normalizePath } from './ErrorNormalizer';
export { GitService, PackLimitError } from './GitService';
export { RefService } from './RefService';
export { ObjectReader } from './ObjectReader';
export { PackCollector } from './PackCollector';
export { HistoryService } from './HistoryService';
export { MergeService } from './MergeService';
export { WriteService, splitFilePath, DEFAULT_MAX_FILE_BYTES, MAX_FILE_PATH_LENGTH } from './WriteService';
export type { CommitFileInput, CommitFileResult, FileAuthor } from './WriteService';
export { isValidBranchName } from './MergeService';
export { computeHunks, diffText, DIFF_CONTEXT_LINES, MAX_DIFF_LINES_PER_FILE } from './DiffHunks';
export type { DiffHunk, DiffLine, DiffLineKind } from './DiffHunks';
export type { RefUpdateResult } from '@edge-git/git-protocol';
// NOTE: `dofs` stays an implementation detail of git-service. Use
// `createDofsFs`/`DofsFs` from `./DofsFsAdapter` instead of importing `dofs` directly.
