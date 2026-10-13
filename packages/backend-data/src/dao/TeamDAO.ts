import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '@rexezuge/d1';

export interface TeamRow {
  id: string;
  org_id: string;
  slug: string;
  slug_ci: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

class TeamDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async create(input: {
    id: string;
    orgId: string;
    slug: string;
    name: string;
    description?: string | null;
    createdBy: string;
    now: number;
  }): Promise<void> {
    await this.run('INSERT INTO teams (id, org_id, slug, slug_ci, name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [input.id, input.orgId, input.slug, input.slug.toLowerCase(), input.name, input.description ?? null, input.createdBy, input.now, input.now]);
  }

  public async getById(id: string): Promise<TeamRow | null> {
    return this.findRowById<TeamRow>('teams', 'id', id);
  }

  public async getByOrgAndSlug(orgId: string, slugCi: string): Promise<TeamRow | null> {
    return this.database
      .prepare('SELECT * FROM teams WHERE org_id = ? AND slug_ci = ? LIMIT 1')
      .bind(orgId, slugCi.toLowerCase())
      .first<TeamRow>();
  }

  public async listByOrg(orgId: string, limit = 100): Promise<TeamRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM teams WHERE org_id = ? ORDER BY created_at ASC LIMIT ?')
      .bind(orgId, limit)
      .all<TeamRow>();
    return result.results ?? [];
  }

  public async countByOrg(orgId: string): Promise<number> {
    const row = await this.database.prepare('SELECT COUNT(*) AS n FROM teams WHERE org_id = ?').bind(orgId).first<{ n: number }>();
    return row?.n ?? 0;
  }

  public async rename(id: string, slug: string, name: string, description: string | null, now: number): Promise<void> {
    await this.run('UPDATE teams SET slug = ?, slug_ci = ?, name = ?, description = ?, updated_at = ? WHERE id = ?', [slug, slug.toLowerCase(), name, description, now, id]);
  }

  public async deleteById(id: string): Promise<void> {
    await this.run('DELETE FROM teams WHERE id = ?', [id]);
  }

  public async deleteByOrg(orgId: string): Promise<void> {
    await this.run('DELETE FROM teams WHERE org_id = ?', [orgId]);
  }
}

export { TeamDAO };
