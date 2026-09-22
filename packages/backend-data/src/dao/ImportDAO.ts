import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';

type ImportStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

function parseRefsJson(raw: string): Array<{ ref: string; oid: string | null }> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Array<{ ref: string; oid: string | null }> = [];
    for (const entry of parsed) {
      const ref = (entry as { ref?: unknown }).ref;
      if (typeof ref !== 'string' || ref.length === 0) continue;
      const oid = (entry as { oid?: unknown }).oid;
      out.push({ ref, oid: typeof oid === 'string' ? oid : null });
    }
    return out;
  } catch {
    return [];
  }
}

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

  public async create(input: { id: string; repositoryId: string; sourceUrl: string; createdBy: string; now: number }): Promise<void> {
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

  public async countActiveForRepo(repositoryId: string): Promise<number> {
    const row = await this.database
      .prepare("SELECT COUNT(*) AS n FROM repo_imports WHERE repository_id = ? AND status IN ('pending', 'running')")
      .bind(repositoryId)
      .first<{ n: number }>();
    return row?.n ?? 0;
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
          .prepare(
            "UPDATE repo_imports SET status = 'done', error = NULL, refs_json = ?, imported_refs = ?, updated_at = ? WHERE id = ? AND status IN ('pending', 'running')",
          )
          .bind(refsJson, importedRefs, now, id)
          .run(),
      'mark repo import done',
    );
    // Dual-write the 3NF junction (0022): best-effort, JSON stays
    // authoritative until the drop migration; reads prefer junction rows.
    await this.replaceRefs(id, parseRefsJson(refsJson), now).catch(() => undefined);
  }

  public async listRefs(importId: string): Promise<Array<{ ref: string; oid: string | null }>> {
    const result = await this.database
      .prepare('SELECT ref_name, oid FROM repo_import_refs WHERE import_id = ?')
      .bind(importId)
      .all<{ ref_name: string; oid: string | null }>();
    return (result.results ?? []).map((row) => ({ ref: row.ref_name, oid: row.oid }));
  }

  public async replaceRefs(importId: string, refs: ReadonlyArray<{ ref: string; oid: string | null }>, now: number): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM repo_import_refs WHERE import_id = ?').bind(importId).run(),
      'replace repo import refs',
    );
    for (const ref of refs) {
      await this.withRetry(
        () =>
          this.database
            .prepare('INSERT OR IGNORE INTO repo_import_refs (import_id, ref_name, oid, created_at) VALUES (?, ?, ?, ?)')
            .bind(importId, ref.ref, ref.oid, now)
            .run(),
        'insert repo import ref',
      );
    }
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
      () =>
        this.database
          .prepare('DELETE FROM repo_import_refs WHERE import_id IN (SELECT id FROM repo_imports WHERE repository_id = ?)')
          .bind(repositoryId)
          .run(),
      'delete repo import refs',
    ).catch(() => undefined);
    await this.withRetry(
      () => this.database.prepare('DELETE FROM repo_imports WHERE repository_id = ?').bind(repositoryId).run(),
      'delete repo imports',
    );
  }
}

export { ImportDAO };
export type { ImportStatus, RepoImportRow };
