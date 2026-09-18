import type { BranchProtectionRule } from '../types';
import { apiDelete, apiGet, apiPost } from '../lib/api';

function authedBase(owner: string, repo: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export async function listRules(owner: string, repo: string): Promise<BranchProtectionRule[]> {
  const data = await apiGet<{ rules?: BranchProtectionRule[] }>(`${authedBase(owner, repo)}/rules`);
  return data.rules ?? [];
}

export async function createRule(
  owner: string,
  repo: string,
  input: {
    pattern: string;
    requirePr?: boolean;
    requiredApprovals?: number;
    blockForcePush?: boolean;
    blockDeletion?: boolean;
    requireStatusChecks?: string[];
  },
): Promise<{ rule: BranchProtectionRule }> {
  return apiPost<{ rule: BranchProtectionRule }>(`${authedBase(owner, repo)}/rules`, input);
}

export async function deleteRule(owner: string, repo: string, ruleId: string): Promise<void> {
  await apiDelete<{ ok: boolean }>(`${authedBase(owner, repo)}/rules/${encodeURIComponent(ruleId)}`);
}
