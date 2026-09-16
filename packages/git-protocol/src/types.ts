export interface RefUpdateResult {
  ref: string;
  ok: boolean;
  error?: string;
}

/**
 * Branch protection resolved by the API (which owns D1) and passed into the
 * `RepoWorker` DO (which owns git truth but cannot read D1). `ref` is the
 * full ref name (e.g. `refs/heads/main`); only branch refs are ever sent.
 */
export interface ProtectedRefRule {
  ref: string;
  requirePr: boolean;
  blockForcePush: boolean;
  blockDeletion: boolean;
}
