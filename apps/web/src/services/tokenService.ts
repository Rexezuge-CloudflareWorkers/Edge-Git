import type { CreatedToken, TokenMetadata, TokenScope } from '../types';
import { apiDelete, apiGet, apiPost } from '../lib/api';

export async function listTokens(): Promise<TokenMetadata[]> {
  const data = await apiGet<{ tokens?: TokenMetadata[] }>('/user/tokens');
  return data.tokens ?? [];
}

export async function createToken(name: string, scopes?: TokenScope[], expiresInDays?: number): Promise<CreatedToken> {
  return apiPost<CreatedToken>('/user/tokens', { name, scopes, expiresInDays });
}

export async function revokeToken(tokenId: string): Promise<void> {
  await apiDelete<{ ok: boolean }>(`/user/tokens/${encodeURIComponent(tokenId)}`);
}
