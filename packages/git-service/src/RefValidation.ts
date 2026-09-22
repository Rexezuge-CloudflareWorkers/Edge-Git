// Pure ref-name validation + command classification (Policy pattern).
//
// Canonical branch rule lives in `@edge-git/shared/utils` (Layer 0) so
// `backend-services` never imports `git-service`. This module is the
// git-side policy facade: OID checks, ref-path builders, and receive-pack
// command classification shared by `RefService` validate + mutate phases.
export { isValidBranchName } from '@edge-git/shared/utils';

const ZERO_OID = '0'.repeat(40);
const COMMIT_OID_RE = /^[0-9a-f]{40}$/i;

function isCommitOid(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_OID_RE.test(value);
}

function isZeroOid(value: unknown): boolean {
  return value === ZERO_OID;
}

function branchRefFor(name: string): string {
  return `refs/heads/${name}`;
}

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function isDeleteCommand(cmd: RefCommand): boolean {
  return cmd.newOid === ZERO_OID;
}

function isCreateCommand(cmd: RefCommand): boolean {
  return cmd.oldOid === ZERO_OID;
}

function classifyRefCommand(cmd: RefCommand): 'delete' | 'create' | 'update' {
  if (isDeleteCommand(cmd)) return 'delete';
  if (isCreateCommand(cmd)) return 'create';
  return 'update';
}

export { ZERO_OID, COMMIT_OID_RE, isCommitOid, isZeroOid, branchRefFor, isDeleteCommand, isCreateCommand, classifyRefCommand };
export type { RefCommand };
