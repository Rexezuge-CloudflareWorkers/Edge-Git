import { ZERO_OID as SHARED_ZERO_OID } from '@edge-git/shared/constants';
import { isZeroGitOid } from '@edge-git/shared/utils';

export { ZERO_OID } from '@edge-git/shared/constants';
export { isValidBranchName } from '@edge-git/shared/utils';

const COMMIT_OID_RE = /^[0-9a-f]{40}$/i;

function isCommitOid(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_OID_RE.test(value);
}

function isZeroOid(value: unknown): boolean {
  return isZeroGitOid(value);
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
  return cmd.newOid === SHARED_ZERO_OID;
}

function isCreateCommand(cmd: RefCommand): boolean {
  return cmd.oldOid === SHARED_ZERO_OID;
}

function classifyRefCommand(cmd: RefCommand): 'delete' | 'create' | 'update' {
  if (isDeleteCommand(cmd)) return 'delete';
  if (isCreateCommand(cmd)) return 'create';
  return 'update';
}

export { COMMIT_OID_RE, isCommitOid, isZeroOid, branchRefFor, isDeleteCommand, isCreateCommand, classifyRefCommand };
export type { RefCommand };
