import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';

export type OrgMemberRole = 'owner' | 'member';

export interface OrganizationMemberRow {
  org_id: string;
  user_email: string;
  /**
  Account key (0028). NULL only for rows written before the migration.
  */
  user_id?: string | null;
  role: OrgMemberRole;
  created_at: number;
}

class OrganizationMemberDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  /**
   * `userEmail` is the account's frozen anchor (what legacy rows and the
   * foreign key store); `userId` is what membership is actually keyed on, so a
   * member keeps access after changing their address.
   */
  public async upsert(orgId: string, userEmail: string, role: OrgMemberRole, now: number, userId?: string | null): Promise<void> {
    const normalized = userEmail.toLowerCase();
    await this.withRetry(async () => {
      // Collapse legacy mixed-case duplicates so `lower(user_email)` reads stay unique.
      await this.database
        .prepare('DELETE FROM organization_members WHERE org_id = ? AND lower(user_email) = ? AND user_email != ?')
        .bind(orgId, normalized, normalized)
        .run()
        .catch(() => undefined);
      return this.database
        .prepare(
          'INSERT INTO organization_members (org_id, user_email, role, created_at, user_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(org_id, user_email) DO UPDATE SET role = excluded.role, user_id = COALESCE(excluded.user_id, organization_members.user_id)',
        )
        .bind(orgId, normalized, role, now, userId ?? null)
        .run();
    }, 'upsert organization member');
  }

  public async get(orgId: string, userEmail: string): Promise<OrganizationMemberRow | null> {
    return this.database
      .prepare('SELECT * FROM organization_members WHERE org_id = ? AND lower(user_email) = lower(?) LIMIT 1')
      .bind(orgId, userEmail)
      .first<OrganizationMemberRow>();
  }

  /**
  Membership read by account key. Authoritative once 0028 has backfilled.
  */
  public async getByUserId(orgId: string, userId: string): Promise<OrganizationMemberRow | null> {
    return this.database
      .prepare('SELECT * FROM organization_members WHERE org_id = ? AND user_id = ? LIMIT 1')
      .bind(orgId, userId)
      .first<OrganizationMemberRow>();
  }

  public async listByOrg(orgId: string, limit = 200): Promise<OrganizationMemberRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM organization_members WHERE org_id = ? ORDER BY created_at ASC LIMIT ?')
      .bind(orgId, limit)
      .all<OrganizationMemberRow>();
    return result.results ?? [];
  }

  public async listOrgsByUser(userEmail: string, limit = 200): Promise<OrganizationMemberRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM organization_members WHERE lower(user_email) = lower(?) ORDER BY created_at ASC LIMIT ?')
      .bind(userEmail, limit)
      .all<OrganizationMemberRow>();
    return result.results ?? [];
  }

  /**
  Org ids for an account, resolved by key so an address change is survivable.
  */
  public async listOrgsByUserId(userId: string, limit = 200): Promise<OrganizationMemberRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM organization_members WHERE user_id = ? ORDER BY created_at ASC LIMIT ?')
      .bind(userId, limit)
      .all<OrganizationMemberRow>();
    return result.results ?? [];
  }

  public async remove(orgId: string, userEmail: string): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare('DELETE FROM organization_members WHERE org_id = ? AND lower(user_email) = lower(?)')
          .bind(orgId, userEmail)
          .run(),
      'remove organization member',
    );
  }

  public async deleteByOrg(orgId: string): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM organization_members WHERE org_id = ?').bind(orgId).run(),
      'delete members by org',
    );
  }

  public async countOwners(orgId: string): Promise<number> {
    const row = await this.database
      .prepare("SELECT COUNT(*) AS n FROM organization_members WHERE org_id = ? AND role = 'owner'")
      .bind(orgId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
}

export { OrganizationMemberDAO };
