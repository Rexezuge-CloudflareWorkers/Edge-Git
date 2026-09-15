export interface CurrentUser {
  email: string;
  /**
   * Preferred UI language (BCP 47 tag). Optional: the backend does not persist
   * it yet, so the SPA treats a missing value as "use localStorage > navigator
   * > en" and persists language changes locally (best-effort `PATCH /user/me`
   * when the backend starts accepting it).
   */
  preferredLanguage?: string | null;
}

export interface Repo {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  createdAt: number;
  updatedAt: number;
  viewerCanManage?: boolean;
}

export interface BranchesResponse {
  branches: string[];
  currentBranch: string | null;
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  oid: string;
  lastCommit: GitCommit | null;
}

export interface GitCommitAuthor {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: number;
}

export interface GitCommit {
  oid: string;
  commit: {
    message: string;
    author: GitCommitAuthor;
    committer: GitCommitAuthor;
    parent: string[];
    tree: string;
  };
  payload: string;
}

export interface BlobResponse {
  oid: string;
  size: number;
  isBinary: boolean;
  contentBase64?: string;
}

export interface Issue {
  id: string;
  repository_id: string;
  full_name: string;
  number: number;
  title: string;
  body: string | null;
  status: string;
  creator_email: string;
  created_at: number;
  updated_at: number;
}

export interface TokenMetadata {
  tokenId: string;
  name: string;
  expiresAt: number;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface CreatedToken {
  tokenId: string;
  token: string;
  name: string;
  expiresAt: number;
}
