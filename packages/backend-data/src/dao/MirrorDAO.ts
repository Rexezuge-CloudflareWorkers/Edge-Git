import { DatabaseError } from '@edge-git/backend-errors';
import { decryptData, encryptData } from '../crypto/aes-gcm';
import type { D1Queryable } from '../utils/D1Types';
import { isMissingSchemaError } from '../utils/D1ErrorClassifier';
import { EncryptedDAO } from './BaseDAO';

interface RepoMirrorRow {
  repository_id: string;
  source_url: string;
  // AES-GCM envelope (0026): per-feature key `MIRROR_ENCRYPTION_KEY_SECRET`.
  // Dual-written with `source_url`; reads prefer the envelope with plaintext
  // fallback until the backfill/drop migration lands.
  encrypted_source_url?: string | null;
  source_url_iv?: string | null;
  interval_minutes: number;
  enabled: number;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  consecutive_failures: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

class MirrorDAO extends EncryptedDAO {
  constructor(database: D1Queryable, masterKey?: string) {
    // Empty key = legacy plaintext mode (unit fakes without Secrets Store).
    // Production always wires a key via daoBindings (fail closed there).
    super(database, masterKey ?? '');
  }

  private async resolveSourceUrl(row: RepoMirrorRow): Promise<string> {
    if (row.encrypted_source_url && row.source_url_iv) {
      if (!this.masterKey) throw new DatabaseError('Mirror encryption key is not configured for this scope.');
      try {
        return await decryptData(row.encrypted_source_url, row.source_url_iv, this.masterKey);
      } catch (error) {
        throw new DatabaseError(`Failed to decrypt mirror source URL: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    return row.source_url;
  }

  private async withDecryptedSourceUrl(rows: RepoMirrorRow[]): Promise<RepoMirrorRow[]> {
    const out: RepoMirrorRow[] = [];
    for (const row of rows) out.push({ ...row, source_url: await this.resolveSourceUrl(row) });
    return out;
  }

  public async upsert(input: {
    repositoryId: string;
    sourceUrl: string;
    intervalMinutes: number;
    createdBy: string;
    now: number;
  }): Promise<void> {
    const envelope = this.masterKey ? await encryptData(input.sourceUrl, this.masterKey) : null;
    const encrypted = envelope?.encrypted ?? null;
    const iv = envelope?.iv ?? null;
    try {
      await this.withRetry(
        () =>
          this.database
            .prepare(
              `INSERT INTO repo_mirrors (repository_id, source_url, interval_minutes, enabled, last_run_at, last_status, last_error, consecutive_failures, created_by, created_at, updated_at, encrypted_source_url, source_url_iv)
               VALUES (?, ?, ?, 1, NULL, NULL, NULL, 0, ?, ?, ?, ?, ?)
               ON CONFLICT (repository_id) DO UPDATE SET source_url = excluded.source_url, interval_minutes = excluded.interval_minutes, enabled = 1, updated_at = excluded.updated_at, encrypted_source_url = excluded.encrypted_source_url, source_url_iv = excluded.source_url_iv`,
            )
            .bind(input.repositoryId, input.sourceUrl, input.intervalMinutes, input.createdBy, input.now, input.now, encrypted, iv)
            .run(),
        'upsert repo mirror',
      );
    } catch (error) {
      // Pre-0026 databases (deploy skew / local dev): legacy column list.
      if (!isMissingSchemaError(error)) throw error;
      await this.withRetry(
        () =>
          this.database
            .prepare(
              `INSERT INTO repo_mirrors (repository_id, source_url, interval_minutes, enabled, last_run_at, last_status, last_error, consecutive_failures, created_by, created_at, updated_at)
               VALUES (?, ?, ?, 1, NULL, NULL, NULL, 0, ?, ?, ?)
               ON CONFLICT (repository_id) DO UPDATE SET source_url = excluded.source_url, interval_minutes = excluded.interval_minutes, enabled = 1, updated_at = excluded.updated_at`,
            )
            .bind(input.repositoryId, input.sourceUrl, input.intervalMinutes, input.createdBy, input.now, input.now)
            .run(),
        'upsert repo mirror',
      );
    }
  }

  public async getByRepo(repositoryId: string): Promise<RepoMirrorRow | null> {
    const row = await this.findRowById<RepoMirrorRow>('repo_mirrors', 'repository_id', repositoryId);
    if (!row) return null;
    return { ...row, source_url: await this.resolveSourceUrl(row) };
  }

  public async listDue(now: number, limit: number): Promise<RepoMirrorRow[]> {
    const result = await this.database
      .prepare(
        'SELECT * FROM repo_mirrors WHERE enabled = 1 AND (last_run_at IS NULL OR last_run_at + interval_minutes * 60 <= ?) ORDER BY last_run_at ASC NULLS FIRST, repository_id ASC LIMIT ?',
      )
      .bind(now, limit)
      .all<RepoMirrorRow>();
    return this.withDecryptedSourceUrl(result.results ?? []);
  }

  public async recordRun(repositoryId: string, ok: boolean, error: string | null, now: number, maxFailures: number): Promise<void> {
    if (ok) {
      await this.withRetry(
        () =>
          this.database
            .prepare(
              "UPDATE repo_mirrors SET last_run_at = ?, last_status = 'ok', last_error = NULL, consecutive_failures = 0, updated_at = ? WHERE repository_id = ?",
            )
            .bind(now, now, repositoryId)
            .run(),
        'record mirror success',
      );
      return;
    }
    await this.withRetry(
      () =>
        this.database
          .prepare(
            `UPDATE repo_mirrors SET last_run_at = ?, last_status = 'failed', last_error = ?,
             consecutive_failures = consecutive_failures + 1,
             enabled = CASE WHEN consecutive_failures + 1 >= ? THEN 0 ELSE enabled END,
             updated_at = ? WHERE repository_id = ?`,
          )
          .bind(now, (error ?? 'mirror failed').slice(0, 500), maxFailures, now, repositoryId)
          .run(),
      'record mirror failure',
    );
  }

  public async setEnabled(repositoryId: string, enabled: boolean, now: number): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare('UPDATE repo_mirrors SET enabled = ?, consecutive_failures = 0, updated_at = ? WHERE repository_id = ?')
          .bind(enabled ? 1 : 0, now, repositoryId)
          .run(),
      'set mirror enabled',
    );
  }

  public async deleteByRepo(repositoryId: string): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM repo_mirrors WHERE repository_id = ?').bind(repositoryId).run(),
      'delete repo mirror',
    );
  }
}

export { MirrorDAO };
export type { RepoMirrorRow };
