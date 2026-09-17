import type { RepoSecuritySettings, SecretScanMode } from '../types';
import { apiGet, apiPatch } from '../lib/api';

function securityPath(owner: string, repo: string): string {
  return `/user/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/security`;
}

export async function getSecuritySettings(owner: string, repo: string): Promise<RepoSecuritySettings> {
  const data = await apiGet<{ settings: RepoSecuritySettings }>(securityPath(owner, repo));
  return data.settings;
}

export async function setSecretScanMode(owner: string, repo: string, secretScanMode: SecretScanMode): Promise<RepoSecuritySettings> {
  const data = await apiPatch<{ settings: RepoSecuritySettings }>(securityPath(owner, repo), { secretScanMode });
  return data.settings;
}
