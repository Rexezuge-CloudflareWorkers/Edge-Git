import { UserDAO } from '@edge-git/backend-data/dao';
import type { D1Queryable } from '@edge-git/backend-data/utils';

interface IdentityResolverEnv {
  DB: D1Queryable;
}

interface IdentityResolverDeps {
  userDAO?: () => Promise<UserDAO>;
}

const GHOST_USERNAME = 'ghost';

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Email is the stable unique identifier (mutable usernames would orphan
// history on rename). This resolver maps stored emails to current usernames
// at read time only — D1 rows keep `*_email` columns untouched.
class IdentityResolver {
  private readonly deps: Required<IdentityResolverDeps>;

  constructor(
    private readonly env: IdentityResolverEnv,
    deps: IdentityResolverDeps = {},
  ) {
    this.deps = {
      userDAO: () => Promise.resolve(new UserDAO(env.DB)),
      ...deps,
    };
  }

  public static ghost(): string {
    return GHOST_USERNAME;
  }

  public async resolveUsernames(emails: unknown[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const raw of emails) {
      if (typeof raw !== 'string' || !raw) continue;
      const key = normalizeEmail(raw);
      if (!key || key.length > 254 || !/^[^@\s]+@[^\s@]+\.[^\s@]+$/.test(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(key);
    }
    if (deduped.length === 0) return out;
    try {
      const dao = await this.deps.userDAO();
      const rows = await dao.getByEmails(deduped);
      const byEmail = new Map<string, string>();
      for (const row of rows) {
        const username = row.username?.trim();
        if (username && row.email) byEmail.set(normalizeEmail(row.email), username);
      }
      for (const key of deduped) {
        out.set(key, byEmail.get(key) ?? GHOST_USERNAME);
      }
    } catch {
      for (const key of deduped) {
        if (!out.has(key)) out.set(key, GHOST_USERNAME);
      }
    }
    return out;
  }

  public async resolveUsername(email: string): Promise<string> {
    const key = normalizeEmail(email);
    if (!key) return GHOST_USERNAME;
    const map = await this.resolveUsernames([key]);
    return map.get(key) ?? GHOST_USERNAME;
  }

  // Accepts `username` or `email` (for filters like `?user=` / `?userEmail=`).
  // Returns the canonical stored email, or null when unknown.
  public async resolveEmail(usernameOrEmail: unknown): Promise<string | null> {
    if (typeof usernameOrEmail !== 'string') return null;
    const raw = usernameOrEmail.trim();
    if (!raw || raw.length > 254) return null;
    if (raw.includes('@')) {
      const normalized = normalizeEmail(raw);
      if (!/^[^@\s]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return null;
      return normalized;
    }
    try {
      const dao = await this.deps.userDAO();
      const row = await dao.getByUsernameCi(raw.toLowerCase());
      return row ? normalizeEmail(row.email) : null;
    } catch {
      return null;
    }
  }
}

export { IdentityResolver, GHOST_USERNAME };
export type { IdentityResolverDeps, IdentityResolverEnv };
