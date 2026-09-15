import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { UserAccessTokenDAO } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError, UnauthorizedError } from '@edge-git/backend-errors';
import type { UserAccessTokenMetadata } from '@edge-git/shared';
import { TimestampUtil, UUIDUtil, CryptoUtil } from '@edge-git/shared/utils';

interface TokenServiceEnv {
  DB: D1Queryable;
  MAX_TOKENS_PER_USER?: string;
  MAX_TOKEN_EXPIRY_DAYS?: string;
}

interface CreatedToken {
  tokenId: string;
  token: string;
  name: string;
  expiresAt: number;
}

class TokenService {
  constructor(private readonly env: TokenServiceEnv) {}

  public static async hashToken(token: string): Promise<string> {
    return CryptoUtil.sha256Hex(`edge-git-pat:${token}`);
  }

  public async authenticateWithPAT(token: string): Promise<string> {
    const dao = new UserAccessTokenDAO(this.env.DB);
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const tokenHash = await TokenService.hashToken(token);
    const tokenData: UserAccessTokenMetadata | undefined = await dao.getByTokenHash(tokenHash, now);
    if (tokenData) {
      await dao.updateLastUsedByHash(tokenHash, now);
      return tokenData.userEmail;
    }
    throw new UnauthorizedError('Your personal access token is invalid or has expired.');
  }

  public async createToken(userEmail: string, name: string, expiresInDays?: number): Promise<CreatedToken> {
    const dao = new UserAccessTokenDAO(this.env.DB);
    const maxTokens: number = ConfigurationManager.token.getMaxPerUser(this.env);
    const maxExpiryInDays: number = ConfigurationManager.token.getMaxExpiryDays(this.env);
    const existingTokens: UserAccessTokenMetadata[] = await dao.getByUserEmail(userEmail);
    if (existingTokens.length >= maxTokens) {
      throw new BadRequestError(`Maximum ${maxTokens} tokens allowed per user`);
    }
    const effectiveExpiryInDays: number = expiresInDays || maxExpiryInDays;
    if (effectiveExpiryInDays > maxExpiryInDays) {
      throw new BadRequestError(`Token expiry cannot exceed ${maxExpiryInDays} days`);
    }
    const tokenId: string = UUIDUtil.getRandomUUID();
    const token: string = UUIDUtil.getRandomUUIDNoDash() + UUIDUtil.getRandomUUIDNoDash();
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const expiresAt: number = TimestampUtil.addDays(now, effectiveExpiryInDays);
    const tokenHash = await TokenService.hashToken(token);
    await dao.create(tokenId, userEmail, tokenHash, name, expiresAt, now);
    return { tokenId, token, name, expiresAt };
  }

  public async listTokens(userEmail: string): Promise<UserAccessTokenMetadata[]> {
    const dao = new UserAccessTokenDAO(this.env.DB);
    return dao.getByUserEmail(userEmail);
  }

  public async deleteToken(tokenId: string, userEmail: string): Promise<void> {
    const dao = new UserAccessTokenDAO(this.env.DB);
    await dao.delete(tokenId, userEmail);
  }
}

class TokenServiceFactory {
  public static create(env: TokenServiceEnv): TokenService {
    return new TokenService(env);
  }
}

export { TokenService, TokenServiceFactory };
export type { CreatedToken, TokenServiceEnv };
