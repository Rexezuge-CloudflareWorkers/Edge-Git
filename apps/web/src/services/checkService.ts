import type { CheckRun } from '../types';
import { apiGet } from '../lib/api';

export type CheckCombinedState = 'pending' | 'success' | 'failure';

export async function listChecks(owner: string, repo: string, sha: string): Promise<{ state: CheckCombinedState; checks: CheckRun[] }> {
  const data = await apiGet<{ state?: CheckCombinedState; checks?: CheckRun[] }>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}/checks`,
  );
  return { state: data.state ?? 'pending', checks: data.checks ?? [] };
}
