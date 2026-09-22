import { BaseDAO } from './BaseDAO';
import type { D1Queryable } from '../utils/D1Types';

interface RepoWebhookRow {
  id: string;
  repository_id: string;
  full_name: string;
  url: string;
  url_prefix: string;
  secret: string;
  secret_suffix: string;
  events: string;
  is_active: number;
  consecutive_failures: number;
  last_delivery_at: number | null;
  last_delivery_status: string | null;
  creator_email: string;
  created_at: number;
  updated_at: number;
}

function parseEventsJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === 'string' && e.length > 0);
  } catch {
    return [];
  }
}

class WebhookDAO extends BaseDAO {
  constructor(database: D1Queryable) {
    super(database);
  }

  public async create(input: {
    id: string;
    repositoryId: string;
    fullName: string;
    url: string;
    urlPrefix: string;
    secret: string;
    secretSuffix: string;
    eventsJson: string;
    creatorEmail: string;
    now: number;
  }): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare(
            'INSERT INTO repo_webhooks (id, repository_id, full_name, url, url_prefix, secret, secret_suffix, events, is_active, consecutive_failures, last_delivery_at, last_delivery_status, creator_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, NULL, ?, ?, ?)',
          )
          .bind(
            input.id,
            input.repositoryId,
            input.fullName,
            input.url,
            input.urlPrefix,
            input.secret,
            input.secretSuffix,
            input.eventsJson,
            input.creatorEmail,
            input.now,
            input.now,
          )
          .run(),
      'create repo webhook',
    );
    // Dual-write the 3NF junction (0022): best-effort, JSON stays
    // authoritative until the drop migration; reads prefer junction rows.
    await this.replaceEvents(input.id, parseEventsJson(input.eventsJson), input.now).catch(() => undefined);
  }

  public async listEvents(hookId: string): Promise<string[]> {
    const result = await this.database.prepare('SELECT event FROM webhook_events WHERE hook_id = ?').bind(hookId).all<{ event: string }>();
    return (result.results ?? []).map((row) => row.event);
  }

  public async replaceEvents(hookId: string, events: readonly string[], now: number): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM webhook_events WHERE hook_id = ?').bind(hookId).run(),
      'replace webhook events',
    );
    for (const event of events) {
      await this.withRetry(
        () =>
          this.database
            .prepare('INSERT OR IGNORE INTO webhook_events (hook_id, event, created_at) VALUES (?, ?, ?)')
            .bind(hookId, event, now)
            .run(),
        'insert webhook event',
      );
    }
  }

  public async deleteEvents(hookId: string): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM webhook_events WHERE hook_id = ?').bind(hookId).run(),
      'delete webhook events',
    );
  }

  public async listByRepo(repositoryId: string): Promise<RepoWebhookRow[]> {
    const result = await this.database
      .prepare('SELECT * FROM repo_webhooks WHERE repository_id = ? ORDER BY created_at ASC, id ASC')
      .bind(repositoryId)
      .all<RepoWebhookRow>();
    return result.results ?? [];
  }

  public async getById(id: string): Promise<RepoWebhookRow | null> {
    return this.findRowById<RepoWebhookRow>('repo_webhooks', 'id', id);
  }

  public async getByIdAndRepo(id: string, repositoryId: string): Promise<RepoWebhookRow | null> {
    const row = await this.database
      .prepare('SELECT * FROM repo_webhooks WHERE id = ? AND repository_id = ? LIMIT 1')
      .bind(id, repositoryId)
      .first<RepoWebhookRow>();
    return row ?? null;
  }

  public async countByRepo(repositoryId: string): Promise<number> {
    const row = await this.database
      .prepare('SELECT COUNT(*) AS n FROM repo_webhooks WHERE repository_id = ?')
      .bind(repositoryId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  public async update(
    id: string,
    repositoryId: string,
    patch: { url?: string; urlPrefix?: string; eventsJson?: string; isActive?: boolean; now: number },
  ): Promise<void> {
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [patch.now];
    if (patch.url !== undefined && patch.urlPrefix !== undefined) {
      sets.push('url = ?', 'url_prefix = ?');
      params.push(patch.url, patch.urlPrefix);
    }
    if (patch.eventsJson !== undefined) {
      sets.push('events = ?');
      params.push(patch.eventsJson);
    }
    if (patch.isActive !== undefined) {
      sets.push('is_active = ?');
      params.push(patch.isActive ? 1 : 0);
    }
    params.push(id, repositoryId);
    await this.withRetry(
      () =>
        this.database
          .prepare(`UPDATE repo_webhooks SET ${sets.join(', ')} WHERE id = ? AND repository_id = ?`)
          .bind(...params)
          .run(),
      'update repo webhook',
    );
    if (patch.eventsJson !== undefined) {
      await this.replaceEvents(id, parseEventsJson(patch.eventsJson), patch.now).catch(() => undefined);
    }
  }

  public async rotateSecret(id: string, repositoryId: string, secret: string, secretSuffix: string, now: number): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare(
            'UPDATE repo_webhooks SET secret = ?, secret_suffix = ?, consecutive_failures = 0, updated_at = ? WHERE id = ? AND repository_id = ?',
          )
          .bind(secret, secretSuffix, now, id, repositoryId)
          .run(),
      'rotate repo webhook secret',
    );
  }

  public async recordDeliveryOutcome(hookId: string, success: boolean, now: number, disableAfterFailures: number): Promise<void> {
    if (success) {
      await this.withRetry(
        () =>
          this.database
            .prepare(
              'UPDATE repo_webhooks SET last_delivery_at = ?, last_delivery_status = ?, consecutive_failures = 0, updated_at = ? WHERE id = ?',
            )
            .bind(now, 'success', now, hookId)
            .run(),
        'record webhook delivery success',
      );
      return;
    }
    await this.withRetry(
      () =>
        this.database
          .prepare(
            `UPDATE repo_webhooks SET last_delivery_at = ?, last_delivery_status = ?, consecutive_failures = consecutive_failures + 1,
             is_active = CASE WHEN consecutive_failures + 1 >= ? THEN 0 ELSE is_active END, updated_at = ? WHERE id = ?`,
          )
          .bind(now, 'failure', disableAfterFailures, now, hookId)
          .run(),
      'record webhook delivery failure',
    );
  }

  public async deleteById(id: string, repositoryId: string): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('DELETE FROM repo_webhooks WHERE id = ? AND repository_id = ?').bind(id, repositoryId).run(),
      'delete repo webhook',
    );
    await this.deleteEvents(id).catch(() => undefined);
  }

  public async deleteByRepo(repositoryId: string): Promise<void> {
    await this.withRetry(
      () =>
        this.database
          .prepare('DELETE FROM webhook_events WHERE hook_id IN (SELECT id FROM repo_webhooks WHERE repository_id = ?)')
          .bind(repositoryId)
          .run(),
      'delete webhook events by repo',
    ).catch(() => undefined);
    await this.withRetry(
      () => this.database.prepare('DELETE FROM repo_webhooks WHERE repository_id = ?').bind(repositoryId).run(),
      'delete webhooks by repo',
    );
  }

  // Refresh denormalized `full_name` after an owner/org rename. Keyed by
  // stable `repository_id` so hook rows follow the new `owner/name`.
  public async updateFullNameByRepo(repositoryId: string, fullName: string): Promise<void> {
    await this.withRetry(
      () => this.database.prepare('UPDATE repo_webhooks SET full_name = ? WHERE repository_id = ?').bind(fullName, repositoryId).run(),
      'rename webhook full name',
    ).catch(() => undefined);
  }
}

export { WebhookDAO };
export type { RepoWebhookRow };
