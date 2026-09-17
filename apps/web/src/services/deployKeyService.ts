import type { CreatedDeployKey, DeployKey, DeployKeyPermission } from '../types';
import { apiDelete, apiGet, apiPost } from '../lib/api';

function keysPath(owner: string, repo: string, suffix = ''): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/keys${suffix}`;
}

export async function listDeployKeys(owner: string, repo: string): Promise<DeployKey[]> {
  const data = await apiGet<{ keys?: DeployKey[] }>(keysPath(owner, repo));
  return data.keys ?? [];
}

export async function createDeployKey(
  owner: string,
  repo: string,
  name: string,
  permission: DeployKeyPermission,
  expiresInDays?: number,
): Promise<CreatedDeployKey> {
  return apiPost<CreatedDeployKey>(keysPath(owner, repo), { name, permission, expiresInDays });
}

export async function revokeDeployKey(owner: string, repo: string, keyId: string): Promise<void> {
  await apiDelete<{ ok: boolean }>(keysPath(owner, repo, `/${encodeURIComponent(keyId)}`));
}
