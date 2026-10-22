import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '@rexezuge/d1';
import type { SubrequestMeter } from '@rexezuge/shared';
import type { TokenScope } from '@edge-git/shared';

interface TokenRepoGrantRow {
  token_id: string;
  repository_id: string;
  scope: TokenScope;
  created_at: number;
}

class TokenRepoGrantDAO extends BaseDAO {
  constructor(database: D1Queryable, meter?: SubrequestMeter) {
    super(database, meter);
  }

  public async listByToken(tokenId: string): Promise<TokenRepoGrantRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM token_repo_grants WHERE token_id = ? ORDER BY repository_id ASC')
      .bind(tokenId)
      .all<TokenRepoGrantRow>();
    return result.results ?? [];
  }

  public async setGrants(tokenId: string, grants: Array<{ repositoryId: string; scope: TokenScope }>, now: number): Promise<void> {
    await this.run('DELETE FROM token_repo_grants WHERE token_id = ?', [tokenId]);
    for (const grant of grants) {
      await this.run('INSERT INTO token_repo_grants (token_id, repository_id, scope, created_at) VALUES (?, ?, ?, ?)', [tokenId, grant.repositoryId, grant.scope, now]);
    }
  }

  public async deleteByToken(tokenId: string): Promise<void> {
    await this.run('DELETE FROM token_repo_grants WHERE token_id = ?', [tokenId]);
  }

  public async deleteByRepo(repositoryId: string): Promise<void> {
    await this.run('DELETE FROM token_repo_grants WHERE repository_id = ?', [repositoryId]);
  }
}

export { TokenRepoGrantDAO };
export type { TokenRepoGrantRow };
