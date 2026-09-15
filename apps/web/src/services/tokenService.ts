import type { CreatedToken, TokenMetadata } from '../types';
import { apiDelete, apiGet, apiPost } from '../lib/api';

export async function listTokens(): Promise<TokenMetadata[]> {
  const data = await apiGet<{ tokens?: TokenMetadata[] }>('/user/tokens');
  return data.tokens ?? [];
}

export async function createToken(name: string): Promise<CreatedToken> {
  return apiPost<CreatedToken>('/user/tokens', { name });
}

export async function revokeToken(tokenId: string): Promise<void> {
  await apiDelete<{ ok: boolean }>(`/user/tokens/${encodeURIComponent(tokenId)}`);
}
