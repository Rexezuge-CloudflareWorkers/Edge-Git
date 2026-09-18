import { EnvParser } from '../EnvParser';

// Auth / environment identity. Centralizes TEAM_DOMAIN/POLICY_AUD/DEV+DEMO vars.
class AuthConfig {
  constructor(private readonly env: unknown) {}

  public isDemoMode(): boolean {
    return EnvParser.boolean(this.env, 'DEMO_MODE', 'false');
  }

  public getDevAuthEmail(): string | null {
    const value = EnvParser.string(this.env, 'DEV_AUTH_EMAIL', '');
    return value === '' ? null : value;
  }

  public getDemoUserEmail(): string | null {
    const value = EnvParser.string(this.env, 'DEMO_USER_EMAIL', '');
    return value === '' ? null : value;
  }

  public getTeamDomain(): string | null {
    const value = EnvParser.string(this.env, 'TEAM_DOMAIN', '');
    return value === '' ? null : value;
  }

  public getPolicyAud(): string | null {
    const value = EnvParser.string(this.env, 'POLICY_AUD', '');
    return value === '' ? null : value;
  }
}

export { AuthConfig };
