export { IsoGitFs } from './IsoGitFs';
export { GitCache } from './GitCache';
export {
  createDofsFs,
  setDofsDeviceSize,
  trySetDofsDeviceSize,
  validateChunkSize,
  DEFAULT_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
} from './DofsFsAdapter';
export type { DofsFs, DofsFsContext, DofsFsEnvironment, DofsFsFactory, DofsFsOptions } from './DofsFsAdapter';
export { ErrorNormalizer, ErrorWithCode, normalizePath } from './ErrorNormalizer';
export { GitService } from './GitService';
export { RefService } from './RefService';
export {
  ZERO_OID,
  isCommitOid,
  isZeroOid,
  branchRefFor,
  isDeleteCommand,
  isCreateCommand,
  classifyRefCommand,
  isValidBranchName,
} from './RefValidation';
export type { RefCommand } from './RefValidation';
export { parseSymbolicHead } from './RefParsers';
export { ObjectReader } from './ObjectReader';
export { PackCollector } from './PackCollector';
export { PackDepthResolver } from './PackDepthResolver';
export type { DepthResolveOptions } from './PackDepthResolver';
export { RefUpdatePlanner } from './RefUpdatePlanner';
export type { RefUpdateCommand } from './RefUpdatePlanner';
export { PackLimitError, checkObjectBudget, maxVisitedFor } from './PackLimits';
export { parseBlobFilter, shouldSkipBlob } from './PackFilter';
export type { ParsedBlobFilter } from './PackFilter';
export { HistoryService } from './HistoryService';
export { TreeReader } from './TreeReader';
export { TreeDiffer } from './TreeDiffer';
export type { FileStateChange, TextFile } from './TreeDiffer';
export { BlameReader, MAX_BLAME_LINES, MAX_BLAME_COMMITS, MAX_BLAME_BYTES } from './BlameReader';
export type { BlameLine, BlameResult } from './BlameReader';
export { MergeService } from './MergeService';
export { WriteService, splitFilePath, DEFAULT_MAX_FILE_BYTES, MAX_FILE_PATH_LENGTH } from './WriteService';
export type { CommitFileInput, CommitFileResult, FileAuthor } from './WriteService';
export { computeHunks, diffText, DIFF_CONTEXT_LINES, MAX_DIFF_LINES_PER_FILE } from './DiffHunks';
export type { DiffHunk, DiffLine, DiffLineKind } from './DiffHunks';
export type { RefUpdateResult } from '@edge-git/git-protocol';
// NOTE: `dofs` stays an implementation detail of git-service. Use
// `createDofsFs`/`DofsFs` from `./DofsFsAdapter` instead of importing `dofs` directly.
