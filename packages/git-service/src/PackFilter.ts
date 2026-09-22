/**
 * Pure blob-filter policy for pack negotiation (Layer 2-3).
 *
 * Extracted from `PackCollector` so filter parsing is unit-testable without
 * isomorphic-git or a filesystem. `PackCollector` remains the orchestration
 * facade; this module owns the string/number rules only.
 */

interface ParsedBlobFilter {
  filterBlobs: boolean;
  blobLimit: number | undefined;
}

function parseBlobFilter(filter: string): ParsedBlobFilter {
  const normalized = filter.trim();
  const filterBlobs = normalized === 'blob:none';
  const blobLimitMatch = /^blob:limit=(\d+)$/.exec(normalized);
  const blobLimit = blobLimitMatch ? Math.trunc(Number(blobLimitMatch[1])) : undefined;
  return { filterBlobs, blobLimit };
}

function shouldSkipBlob(size: number, parsed: ParsedBlobFilter): boolean {
  if (parsed.filterBlobs) return true;
  if (parsed.blobLimit !== undefined && Number.isFinite(parsed.blobLimit)) return size > parsed.blobLimit;
  return false;
}

export { parseBlobFilter, shouldSkipBlob };
export type { ParsedBlobFilter };
