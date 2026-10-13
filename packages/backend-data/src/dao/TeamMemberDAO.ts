import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '@rexezuge/d1';

export type TeamMemberRole = 'admin' | 'member';

export interface TeamMemberRow {
  team_id: string;
  user_email: string;
  /**
  Account key (0028). NULL only for rows written before the migration.
  */
  user_id?: string | null;
  role: TeamMemberRole;
  joined_at: number;
}

class TeamMemberDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async upsert(teamId: string, userEmail: string, role: TeamMemberRole, now: number, userId?: string | null): Promise<void> {
    const normalized = userEmail.toLowerCase();
    // Collapse legacy mixed-case duplicates so `lower(user_email)` reads stay
    // unique. Best effort: a missing or failing DELETE leaves the duplicate in
    // place, and the UPSERT below is still correct for the surviving row.
    await this.run(
      'DELETE FROM team_members WHERE team_id = ? AND lower(user_email) = ? AND user_email != ?',
      [teamId, normalized, normalized],
    ).catch(() => undefined);
    await this.run(
      'INSERT INTO team_members (team_id, user_email, role, joined_at, user_id) VALUES (?, ?, ?, ?, ?) ON CONFLICT(team_id, user_email) DO UPDATE SET role = excluded.role, user_id = COALESCE(excluded.user_id, team_members.user_id)',
      [teamId, normalized, role, now, userId ?? null],
    );
  }

  public async get(teamId: string, userEmail: string): Promise<TeamMemberRow | null> {
    return this.database
      .prepare('SELECT * FROM team_members WHERE team_id = ? AND lower(user_email) = lower(?) LIMIT 1')
      .bind(teamId, userEmail)
      .first<TeamMemberRow>();
  }

  /**
  Membership read by account key. Authoritative once 0028 has backfilled.
  */
  public async getByUserId(teamId: string, userId: string): Promise<TeamMemberRow | null> {
    return this.database
      .prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ? LIMIT 1')
      .bind(teamId, userId)
      .first<TeamMemberRow>();
  }

  public async listByTeam(teamId: string, limit = 200): Promise<TeamMemberRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM team_members WHERE team_id = ? ORDER BY joined_at ASC LIMIT ?')
      .bind(teamId, limit)
      .all<TeamMemberRow>();
    return result.results ?? [];
  }

  public async listTeamsByUser(userEmail: string, limit = 200): Promise<TeamMemberRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM team_members WHERE lower(user_email) = lower(?) ORDER BY joined_at ASC LIMIT ?')
      .bind(userEmail, limit)
      .all<TeamMemberRow>();
    return result.results ?? [];
  }

  public async remove(teamId: string, userEmail: string): Promise<void> {
    await this.run('DELETE FROM team_members WHERE team_id = ? AND lower(user_email) = lower(?)', [teamId, userEmail]);
  }

  public async deleteByTeam(teamId: string): Promise<void> {
    await this.run('DELETE FROM team_members WHERE team_id = ?', [teamId]);
  }

  public async countAdmins(teamId: string): Promise<number> {
    const row = await this.database
      .prepare("SELECT COUNT(*) AS n FROM team_members WHERE team_id = ? AND role = 'admin'")
      .bind(teamId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }
}

export { TeamMemberDAO };
