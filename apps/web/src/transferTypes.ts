import type { TokenScope } from './types';

export interface TokenRepoGrant {
  tokenId: string;
  repositoryId: string;
  owner: string;
  name: string;
  fullName: string;
  scope: TokenScope;
}

export interface RotatedToken {
  token: string;
  expiresAt: number;
  prefix: string;
}

export interface RepoGrantInput {
  owner: string;
  name: string;
  scope: TokenScope;
}

export type RepoImportStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface RepoImportJob {
  id: string;
  repositoryId: string;
  sourceUrl: string;
  status: RepoImportStatus;
  error: string | null;
  refs: Array<{ ref: string; oid: string }> | null;
  importedRefs: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface RepoMirror {
  repositoryId: string;
  sourceUrl: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface RepoExport {
  refs: Array<{ ref: string; oid: string }>;
  oids: string[];
  byteLength: number;
  packBase64: string;
}

export type DeployKeyPermission = 'read' | 'write';

export interface DeployKey {
  id: string;
  repositoryId: string;
  name: string;
  tokenPrefix: string | null;
  permission: DeployKeyPermission;
  expiresAt: number;
  lastUsedAt: number | null;
  createdBy: string;
  createdAt: number;
}

export interface CreatedDeployKey {
  id: string;
  name: string;
  key: string;
  prefix: string;
  permission: DeployKeyPermission;
  expiresAt: number;
}

export type SecretScanMode = 'off' | 'warn' | 'block';

export interface RepoSecuritySettings {
  repositoryId: string;
  secretScanMode: SecretScanMode;
  updatedBy: string | null;
  updatedAt: number;
}
