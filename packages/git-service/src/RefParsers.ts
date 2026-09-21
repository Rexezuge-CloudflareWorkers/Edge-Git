/**
 * Pure git ref parsers (Layer 2, no I/O).
 *
 * Extracted from `RefService.listRefs` so HEAD parsing is unit testable
 * without isomorphic-git.
 */
function parseSymbolicHead(headContent: string | Uint8Array): string | null {
  const headStr = typeof headContent === 'string' ? headContent : new TextDecoder().decode(headContent);
  const match = /^ref:\s*(\S.*)$/.exec(headStr.trim());
  return match?.[1] ?? null;
}

export { parseSymbolicHead };
