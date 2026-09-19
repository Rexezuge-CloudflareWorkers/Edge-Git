import { jwtVerify, createRemoteJWKSet } from 'jose';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { UnauthorizedError } from '@edge-git/backend-errors';
import { DEMO_USER_EMAIL } from '@edge-git/shared/constants';

interface AccessAuthEnv {
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  DEV_AUTH_EMAIL?: string;
  DEMO_MODE?: string;
  ENVIRONMENT?: string;
}

interface AccessIdentityContext {
  access?: {
    getIdentity: () => Promise<{ email?: string | null; emailVerified?: boolean | null; email_verified?: boolean | null } | null>;
  };
}

type AccessAuthStrategy = (env: AccessAuthEnv, request: Request, accessCtx?: AccessIdentityContext) => Promise<string | null>;

function isBypassAllowed(env: AccessAuthEnv): boolean {
  return ConfigurationManager.auth.isBypassAllowed(env);
}

function demoModeStrategy(env: AccessAuthEnv): Promise<string | null> {
  if (!isBypassAllowed(env)) return Promise.resolve(null);
  return Promise.resolve(ConfigurationManager.auth.isDemoMode(env) ? DEMO_USER_EMAIL : null);
}

function devEmailStrategy(env: AccessAuthEnv): Promise<string | null> {
  if (!isBypassAllowed(env)) return Promise.resolve(null);
  const raw = env.DEV_AUTH_EMAIL?.trim() ?? '';
  if (!raw) return Promise.resolve(null);
  // Fail closed on malformed bypass emails — fall through to JWT instead of
  // authenticating an invalid identity.
  if (!raw.includes('@') || raw.length > 254 || /\s/.test(raw)) return Promise.resolve(null);
  return Promise.resolve(raw.toLowerCase());
}

async function accessJwtStrategy(env: AccessAuthEnv, request: Request): Promise<string | null> {
  if (env.TEAM_DOMAIN && env.POLICY_AUD) {
    return AccessAuthService.verifyAccessJwt(request, env.TEAM_DOMAIN, env.POLICY_AUD);
  }
  return null;
}

async function accessCtxStrategy(_env: AccessAuthEnv, _request: Request, accessCtx?: AccessIdentityContext): Promise<string | null> {
  const identity = await accessCtx?.access?.getIdentity?.().catch(() => null);
  // Fail closed on unverified identities — mirrors the JWT path's
  // `email_verified === false` reject. Access bindings are trusted, but an
  // unverified identity must never authenticate.
  if (identity?.emailVerified === false || identity?.email_verified === false) return null;
  const raw = identity?.email?.trim().toLowerCase() ?? '';
  if (!raw || !raw.includes('@') || raw.length > 254 || /\s/.test(raw)) return null;
  return raw;
}

const DEFAULT_ACCESS_AUTH_STRATEGIES: readonly AccessAuthStrategy[] = [
  demoModeStrategy,
  devEmailStrategy,
  accessJwtStrategy,
  accessCtxStrategy,
];

class AccessAuthService {
  private static readonly jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  private static jwksFor(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
    const cached = this.jwksCache.get(teamDomain);
    if (cached) return cached;
    const created = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    // Bound the cache so distinct team domains cannot grow it without limit.
    if (this.jwksCache.size >= 10) this.jwksCache.clear();
    this.jwksCache.set(teamDomain, created);
    return created;
  }
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
      const JWKS = this.jwksFor(normalizedTeamDomain);
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: normalizedTeamDomain,
        audience: normalizedPolicyAud,
      });

      if (payload.email_verified === false) {
        throw new UnauthorizedError('Cloudflare Access authentication failed.');
      }
      const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
      if (!email || !email.includes('@')) {
        throw new UnauthorizedError('Cloudflare Access authentication failed.');
      }
      return email;
    } catch (error) {
      if (error instanceof UnauthorizedError) throw error;
      throw new UnauthorizedError('Cloudflare Access authentication failed.');
    }
  }
}

export { AccessAuthService, DEFAULT_ACCESS_AUTH_STRATEGIES };
export type { AccessAuthEnv, AccessIdentityContext, AccessAuthStrategy };
