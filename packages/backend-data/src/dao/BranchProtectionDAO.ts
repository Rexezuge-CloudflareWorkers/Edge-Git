import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';
import type { BranchProtectionRuleMetadata } from '@edge-git/shared';

export interface BranchProtectionRuleRow {
  id: string;
  repository_id: string;
  pattern: string;
  require_pr: number;
  required_approvals: number;
  block_force_push: number;
  block_deletion: number;
  require_status_checks: string | null;
  created_by: string;
  created_at: number;
}

function parseStatusChecks(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 50);
  } catch {
    return [];
  }
}

function toMetadata(row: BranchProtectionRuleRow): BranchProtectionRuleMetadata {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    pattern: row.pattern,
    requirePr: row.require_pr === 1,
    requiredApprovals: row.required_approvals,
    blockForcePush: row.block_force_push === 1,
    blockDeletion: row.block_deletion === 1,
    requireStatusChecks: parseStatusChecks(row.require_status_checks),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

class BranchProtectionDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async create(input: {
    id: string;
    repositoryId: string;
    pattern: string;
    requirePr: boolean;
    requiredApprovals: number;
    blockForcePush: boolean;
    blockDeletion: boolean;
    requireStatusChecks: readonly string[];
    createdBy: string;
    now: number;
  }): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare(
            'INSERT INTO branch_protection_rules (id, repository_id, pattern, require_pr, required_approvals, block_force_push, block_deletion, require_status_checks, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(
            input.id,
            input.repositoryId,
            input.pattern,
            input.requirePr ? 1 : 0,
            input.requiredApprovals,
            input.blockForcePush ? 1 : 0,
            input.blockDeletion ? 1 : 0,
            input.requireStatusChecks.length > 0 ? JSON.stringify([...input.requireStatusChecks]) : null,
            input.createdBy.toLowerCase(),
            input.now,
          )
          .run(),
      'create branch protection rule',
    );
  }

  public async listByRepo(repositoryId: string): Promise<BranchProtectionRuleMetadata[]> {
    const result = await this.database
      .prepare('SELECT * FROM branch_protection_rules WHERE repository_id = ? ORDER BY pattern ASC')
      .bind(repositoryId)
      .all<BranchProtectionRuleRow>();
    return (result.results ?? []).map(toMetadata);
  }

  public async getById(id: string): Promise<BranchProtectionRuleMetadata | null> {
    const row = await this.findRowById<BranchProtectionRuleRow>('branch_protection_rules', 'id', id);
    return row ? toMetadata(row) : null;
  }

  public async getByRepoAndPattern(repositoryId: string, pattern: string): Promise<BranchProtectionRuleMetadata | null> {
    const row = await this.database
      .prepare('SELECT * FROM branch_protection_rules WHERE repository_id = ? AND pattern = ? LIMIT 1')
      .bind(repositoryId, pattern)
      .first<BranchProtectionRuleRow>();
    return row ? toMetadata(row) : null;
  }

  public async countByRepo(repositoryId: string): Promise<number> {
    const row = await this.database
      .prepare('SELECT COUNT(*) AS n FROM branch_protection_rules WHERE repository_id = ?')
      .bind(repositoryId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  public async delete(id: string, repositoryId: string): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM branch_protection_rules WHERE id = ? AND repository_id = ?').bind(id, repositoryId).run(),
      'delete branch protection rule',
    );
  }

  public async deleteByRepo(repositoryId: string): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM branch_protection_rules WHERE repository_id = ?').bind(repositoryId).run(),
      'delete branch protection rules by repo',
    );
  }
}

export { BranchProtectionDAO };
