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

interface TokenServiceDeps {
  tokenDAO?: () => Promise<UserAccessTokenDAO>;
}

class TokenService {
  private readonly deps: Required<TokenServiceDeps>;

  constructor(
    private readonly env: TokenServiceEnv,
    deps: TokenServiceDeps = {},
  ) {
    this.deps = {
      tokenDAO: () => Promise.resolve(new UserAccessTokenDAO(env.DB)),
      ...deps,
    };
  }

  public static async hashToken(token: string): Promise<string> {
    return CryptoUtil.sha256Hex(`edge-git-pat:${token}`);
  }

  public async authenticateWithPAT(token: string): Promise<string> {
    const dao = await this.deps.tokenDAO();
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const tokenHash = await TokenService.hashToken(token);
    const tokenData: UserAccessTokenMetadata | undefined = await dao.getByTokenHash(tokenHash, now);
    if (tokenData) {
      await dao.updateLastUsedByHash(tokenHash, now);
      return tokenData.userEmail.toLowerCase();
    }
    throw new UnauthorizedError('Your personal access token is invalid or has expired.');
  }

  public async createToken(userEmail: string, name: string, expiresInDays?: number): Promise<CreatedToken> {
    const dao = await this.deps.tokenDAO();
    const normalized = userEmail.toLowerCase();
    const maxTokens: number = ConfigurationManager.token.getMaxPerUser(this.env);
    const maxExpiryInDays: number = ConfigurationManager.token.getMaxExpiryDays(this.env);
    const existingTokens: UserAccessTokenMetadata[] = await dao.getByUserEmail(normalized);
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
    await dao.create(tokenId, normalized, tokenHash, name, expiresAt, now);
    return { tokenId, token, name, expiresAt };
  }

  public async listTokens(userEmail: string): Promise<UserAccessTokenMetadata[]> {
    const dao = await this.deps.tokenDAO();
    return dao.getByUserEmail(userEmail);
  }

  public async deleteToken(tokenId: string, userEmail: string): Promise<void> {
    const dao = await this.deps.tokenDAO();
    await dao.delete(tokenId, userEmail);
  }
}

/**
@deprecated Prefer `createRequestScope(env).get(Tokens.TokenService)`; this thin wrapper only preserves backward compatibility.
*/
class TokenServiceFactory {
  public static create(env: TokenServiceEnv): TokenService {
    return new TokenService(env);
  }
}

export { TokenService, TokenServiceFactory };
export type { CreatedToken, TokenServiceDeps, TokenServiceEnv };
