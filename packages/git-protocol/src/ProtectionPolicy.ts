import type { Command } from './ReceiveParser';
import type { ProtectedRefRule } from './types';
import { ZERO_OID as SHARED_ZERO_OID } from '@edge-git/shared/constants';

export { ZERO_OID } from '@edge-git/shared/constants';

function isZeroOid(oid: string): boolean {
  return oid === SHARED_ZERO_OID;
}

// `refs/heads/<branch>` → `<branch>`; anything else (tags, notes) → null.
// Branch protection never applies to non-branch refs.
function branchNameFromRef(ref: string): string | null {
  if (!ref.startsWith('refs/heads/')) return null;
  const branch = ref.slice('refs/heads/'.length);
  return branch || null;
}

/**
 * Pure (no-I/O) protection checks for a single push command: deletion and
 * direct-push (`require_pr`) gates. Force-push detection needs ancestry and
 * lives in the DO's `PushHandler`. Returns an error message when blocked,
 * else null. Creation (zero old oid) is always allowed.
 */
function checkStaticPushProtection(cmd: Command, rule: ProtectedRefRule | undefined): string | null {
  if (!rule) return null;
  const branch = branchNameFromRef(cmd.ref);
  if (!branch) return null;
  const display = `"${branch}"`;
  if (isZeroOid(cmd.newOid)) {
    if (rule.blockDeletion) return `branch ${display} is protected against deletion`;
    return null;
  }
  if (isZeroOid(cmd.oldOid)) return null;
  if (rule.requirePr) return `direct pushes to protected branch ${display} are blocked: open a pull request`;
  return null;
}

export { isZeroOid, branchNameFromRef, checkStaticPushProtection };
export type { Command } from './ReceiveParser';
export type { ProtectedRefRule } from './types';
