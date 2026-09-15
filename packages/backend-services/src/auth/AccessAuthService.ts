import { jwtVerify, createRemoteJWKSet } from 'jose';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { UnauthorizedError } from '@edge-git/backend-errors';
import { DEMO_USER_EMAIL } from '@edge-git/shared/constants';

interface AccessAuthEnv {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  DEV_AUTH_EMAIL?: string;
  DEMO_MODE?: string;
}

interface AccessIdentityContext {
  access?: {
    getIdentity: () => Promise<{ email?: string | null } | null>;
  };
}

type AccessAuthStrategy = (env: AccessAuthEnv, request: Request, accessCtx?: AccessIdentityContext) => Promise<string | null>;

function demoModeStrategy(env: AccessAuthEnv): Promise<string | null> {
  return Promise.resolve(ConfigurationManager.auth.isDemoMode(env) ? DEMO_USER_EMAIL : null);
}

function devEmailStrategy(env: AccessAuthEnv): Promise<string | null> {
  return Promise.resolve(env.DEV_AUTH_EMAIL ?? null);
}

async function accessJwtStrategy(env: AccessAuthEnv, request: Request): Promise<string | null> {
  if (env.TEAM_DOMAIN && env.POLICY_AUD) {
    return AccessAuthService.verifyAccessJwt(request, env.TEAM_DOMAIN, env.POLICY_AUD);
  }
  return null;
}

async function accessCtxStrategy(_env: AccessAuthEnv, _request: Request, accessCtx?: AccessIdentityContext): Promise<string | null> {
  const identity = await accessCtx?.access?.getIdentity?.().catch(() => null);
  return identity?.email ?? null;
}

const DEFAULT_ACCESS_AUTH_STRATEGIES: readonly AccessAuthStrategy[] = [
  demoModeStrategy,
  devEmailStrategy,
  accessJwtStrategy,
  accessCtxStrategy,
];

class AccessAuthService {
  private readonly strategies: readonly AccessAuthStrategy[];

  constructor(
    private readonly env: AccessAuthEnv,
    strategies: readonly AccessAuthStrategy[] = DEFAULT_ACCESS_AUTH_STRATEGIES,
  ) {
    this.strategies = strategies;
  }

  public async getAuthenticatedUserEmail(request: Request, accessCtx?: AccessIdentityContext): Promise<string> {
    for (const strategy of this.strategies) {
      const email = await strategy(this.env, request, accessCtx);
      if (email) {
        return email;
      }
    }
    return AccessAuthService.verifyAccessJwt(request, this.env.TEAM_DOMAIN, this.env.POLICY_AUD);
  }

  public static async verifyAccessJwt(request: Request, teamDomain?: string, policyAud?: string): Promise<string> {
    const token = request.headers.get('cf-access-jwt-assertion');
    if (!token) {
      throw new UnauthorizedError('No Cloudflare Access JWT token provided in request headers.');
    }

    if (!teamDomain || !policyAud) {
      throw new UnauthorizedError('Missing required JWT verification configuration.');
    }

    let normalizedTeamDomainEnd: number = teamDomain.length;
    while (normalizedTeamDomainEnd > 0 && teamDomain.charAt(normalizedTeamDomainEnd - 1) === '/') {
      normalizedTeamDomainEnd -= 1;
    }
    const normalizedTeamDomain: string = teamDomain.slice(0, normalizedTeamDomainEnd);
    const normalizedPolicyAud: string = policyAud.trim();
    if (!normalizedPolicyAud) {
      throw new UnauthorizedError('Missing required JWT verification configuration.');
    }
    if (normalizedPolicyAud.includes(',')) {
      throw new UnauthorizedError('Multiple JWT audiences are not supported. Configure a single POLICY_AUD value.');
    }

    try {
      const JWKS = createRemoteJWKSet(new URL(`${normalizedTeamDomain}/cdn-cgi/access/certs`));
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: normalizedTeamDomain,
        audience: normalizedPolicyAud,
      });

      const email = payload.email as string;
      if (!email) {
        throw new UnauthorizedError('No email found in JWT token.');
      }
      return email;
    } catch (error) {
      throw new UnauthorizedError(`JWT verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

/**
@deprecated Prefer `createRequestScope(env).get(Tokens.AccessAuthService)`; this thin wrapper only preserves backward compatibility.
*/
class AccessAuthServiceFactory {
  public static create(env: AccessAuthEnv): AccessAuthService {
    return new AccessAuthService(env);
  }
}

export { AccessAuthService, AccessAuthServiceFactory, DEFAULT_ACCESS_AUTH_STRATEGIES };
export type { AccessAuthEnv, AccessIdentityContext, AccessAuthStrategy };
