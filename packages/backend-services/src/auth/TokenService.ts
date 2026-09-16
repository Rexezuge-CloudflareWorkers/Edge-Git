import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { UserAccessTokenDAO } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';
import { BadRequestError, UnauthorizedError } from '@edge-git/backend-errors';
import type { TokenScope, UserAccessTokenMetadata } from '@edge-git/shared';
import { TimestampUtil, UUIDUtil, CryptoUtil } from '@edge-git/shared/utils';
import { DEFAULT_TOKEN_SCOPES, coversScope, normalizeTokenScopes } from './TokenScopes';

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
  scopes: TokenScope[];
}

interface AuthenticatedToken {
  email: string;
  scopes: TokenScope[];
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

  public async authenticateWithPAT(token: string): Promise<AuthenticatedToken> {
    const dao = await this.deps.tokenDAO();
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const tokenHash = await TokenService.hashToken(token);
    const tokenData: UserAccessTokenMetadata | undefined = await dao.getByTokenHash(tokenHash, now);
    if (tokenData) {
      await dao.updateLastUsedByHash(tokenHash, now);
      return { email: tokenData.userEmail.toLowerCase(), scopes: tokenData.scopes };
    }
    throw new UnauthorizedError('Your personal access token is invalid or has expired.');
  }

  public static coversScope(held: readonly TokenScope[], required: TokenScope): boolean {
    return coversScope(held, required);
  }

  public async createToken(userEmail: string, name: string, expiresInDays?: number, scopes?: unknown): Promise<CreatedToken> {
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
    const effectiveScopes: TokenScope[] = scopes === undefined ? [...DEFAULT_TOKEN_SCOPES] : normalizeTokenScopes(scopes);
    const tokenId: string = UUIDUtil.getRandomUUID();
    const token: string = UUIDUtil.getRandomUUIDNoDash() + UUIDUtil.getRandomUUIDNoDash();
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const expiresAt: number = TimestampUtil.addDays(now, effectiveExpiryInDays);
    const tokenHash = await TokenService.hashToken(token);
    await dao.create(tokenId, normalized, tokenHash, name, expiresAt, now, effectiveScopes);
    return { tokenId, token, name, expiresAt, scopes: effectiveScopes };
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
export type { CreatedToken, AuthenticatedToken, TokenServiceDeps, TokenServiceEnv };
