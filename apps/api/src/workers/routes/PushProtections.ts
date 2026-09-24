import { branchNameFromRef, parseReceivePackRequest } from '@edge-git/git-protocol';
import type { ProtectedRefRule } from '@edge-git/git-protocol';
import type { BranchProtectionRuleMetadata } from '@edge-git/shared';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { BranchProtectionService } from '@edge-git/backend-services/protection';

// Extracted from `GitRoutes.ts` (god-file guard): push-protection resolution
// is pure orchestration (parse → D1 rules → longest-match) with fail-closed
// errors so `registerGitRoutes` stays routing-only.

// Map this push's branch commands to their longest-matching protection
// rules. Tags and other non-branch refs never match. Parse failures throw
// PushBodyInvalidError (400); D1 failures throw PushProtectionsUnavailableError
// (503) so callers fail closed instead of pushing unprotected.
class PushProtectionsUnavailableError extends Error {
  constructor() {
    super('push protections unavailable');
    this.name = 'PushProtectionsUnavailableError';
  }
}

class PushBodyInvalidError extends Error {
  constructor() {
    super('invalid push request');
    this.name = 'PushBodyInvalidError';
  }
}

async function resolvePushProtections(env: Env, repositoryId: string, body: Uint8Array): Promise<ProtectedRefRule[]> {
  let commands: Array<{ ref: string }>;
  try {
    commands = parseReceivePackRequest(body).commands;
  } catch {
    throw new PushBodyInvalidError();
  }
  const branches = new Set<string>();
  for (const cmd of commands) {
    const branch = branchNameFromRef(cmd.ref);
    if (branch) branches.add(branch);
  }
  if (branches.size === 0) return [];
  const scope = createRequestScope(env);
  let rules: BranchProtectionRuleMetadata[];
  try {
    rules = await scope.get(Tokens.BranchProtectionService).listRules(repositoryId);
  } catch {
    throw new PushProtectionsUnavailableError();
  }
  if (rules.length === 0) return [];
  const protections: ProtectedRefRule[] = [];
  for (const branch of branches) {
    const rule = BranchProtectionService.matchRule(rules, branch);
    if (rule) {
      protections.push({
        ref: `refs/heads/${branch}`,
        requirePr: rule.requirePr,
        blockForcePush: rule.blockForcePush,
        blockDeletion: rule.blockDeletion,
      });
    }
  }
  return protections;
}

export { PushBodyInvalidError, PushProtectionsUnavailableError, resolvePushProtections };
