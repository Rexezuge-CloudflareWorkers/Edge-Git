import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';

export interface UserRow {
  email: string;
  created_at: number;
}

class UserDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async upsertUser(email: string, now: number): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare('INSERT INTO users (email, created_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING')
          .bind(email, now)
          .run(),
      'upsert user',
    );
  }

  public async getByEmail(email: string): Promise<UserRow | null> {
    return this.database.prepare('SELECT email, created_at FROM users WHERE email = ? LIMIT 1').bind(email).first<UserRow>();
  }
}

export { UserDAO };
