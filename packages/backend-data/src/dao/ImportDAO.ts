import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';

type ImportStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

interface RepoImportRow {
  id: string;
  repository_id: string;
  source_url: string;
  status: ImportStatus;
  error: string | null;
  refs_json: string | null;
  imported_refs: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

class ImportDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async create(input: {
    id: string;
    repositoryId: string;
    sourceUrl: string;
    createdBy: string;
    now: number;
  }): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare(
            'INSERT INTO repo_imports (id, repository_id, source_url, status, error, refs_json, imported_refs, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)',
          )
          .bind(input.id, input.repositoryId, input.sourceUrl, 'pending', input.createdBy, input.now, input.now)
          .run(),
      'create repo import',
    );
  }

  public async getById(id: string): Promise<RepoImportRow | null> {
    return this.findRowById<RepoImportRow>('repo_imports', 'id', id);
  }

  public async latestByRepo(repositoryId: string): Promise<RepoImportRow | null> {
    const row = await this.database
      .prepare('SELECT * FROM repo_imports WHERE repository_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .bind(repositoryId)
      .first<RepoImportRow>();
    return row ?? null;
  }

  public async hasActiveForRepo(repositoryId: string): Promise<boolean> {
    const row = await this.database
      .prepare("SELECT id FROM repo_imports WHERE repository_id = ? AND status IN ('pending', 'running') LIMIT 1")
      .bind(repositoryId)
      .first<{ id: string }>();
    return row !== null;
  }

  public async claimDue(limit: number, staleAfterSeconds: number, now: number): Promise<RepoImportRow[]> {
    const cutoff = now - staleAfterSeconds;
    const result = await this.database
      .prepare(
        "SELECT * FROM repo_imports WHERE status = 'pending' OR (status = 'running' AND updated_at < ?) ORDER BY created_at ASC, id ASC LIMIT ?",
      )
      .bind(cutoff, limit)
      .all<RepoImportRow>();
    const rows = result.results ?? [];
    for (const row of rows) {
      await this.withRetry(
        () =>
          this.database
            .prepare("UPDATE repo_imports SET status = 'running', updated_at = ? WHERE id = ? AND status IN ('pending', 'running')")
            .bind(now, row.id)
            .run(),
        'claim repo import',
      );
    }
    return rows;
  }

  public async markDone(id: string, refsJson: string, importedRefs: number, now: number): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare("UPDATE repo_imports SET status = 'done', error = NULL, refs_json = ?, imported_refs = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'running')")
          .bind(refsJson, importedRefs, now, id)
          .run(),
      'mark repo import done',
    );
  }

  public async markFailed(id: string, error: string, now: number): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare("UPDATE repo_imports SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'running')")
          .bind(error.slice(0, 500), now, id)
          .run(),
      'mark repo import failed',
    );
  }

  public async markCancelled(id: string, now: number): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare("UPDATE repo_imports SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending', 'running')")
          .bind(now, id)
          .run(),
      'cancel repo import',
    );
  }

  public async deleteByRepo(repositoryId: string): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM repo_imports WHERE repository_id = ?').bind(repositoryId).run(),
      'delete repo imports',
    );
  }
}

export { ImportDAO };
export type { ImportStatus, RepoImportRow };
