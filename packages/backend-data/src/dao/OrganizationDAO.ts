import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '@rexezuge/d1';

export interface OrganizationRow {
  id: string;
  username: string;
  username_ci: string;
  creator_email: string;
  created_at: number;
  updated_at: number;
}

class OrganizationDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async create(input: { id: string; username: string; creatorEmail: string; now: number }): Promise<void> {
    await this.run('INSERT INTO organizations (id, username, username_ci, creator_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [input.id, input.username, input.username.toLowerCase(), input.creatorEmail, input.now, input.now]);
  }

  public async getById(id: string): Promise<OrganizationRow | null> {
    return this.findRowById<OrganizationRow>('organizations', 'id', id);
  }

  public async getByUsernameCi(usernameCi: string): Promise<OrganizationRow | null> {
    return this.database.prepare('SELECT * FROM organizations WHERE username_ci = ? LIMIT 1').bind(usernameCi).first<OrganizationRow>();
  }

  public async rename(id: string, username: string, now: number): Promise<void> {
    await this.run('UPDATE organizations SET username = ?, username_ci = ?, updated_at = ? WHERE id = ?', [username, username.toLowerCase(), now, id]);
  }

  public async deleteById(id: string): Promise<void> {
    await this.run('DELETE FROM organizations WHERE id = ?', [id]);
  }
}

export { OrganizationDAO };
