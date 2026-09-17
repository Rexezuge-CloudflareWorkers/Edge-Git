-- Edge-Git repo webhooks + event deliveries (v1).
-- Additive only: all tables new, no ALTERs, safe for rollback by table drop.
--
-- Each webhook carries its OWN unique signing secret (random per hook,
-- generated at create/rotate time). There is intentionally no shared
-- generic encryption/signing key: secrets are scoped to a single hook,
-- stored in D1 (encrypted at rest by the platform), masked in every API
-- response, and returned in full only once at create/rotate time.

CREATE TABLE IF NOT EXISTS repo_webhooks (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  url TEXT NOT NULL,
  url_prefix TEXT NOT NULL DEFAULT '',
  secret TEXT NOT NULL,
  secret_suffix TEXT NOT NULL DEFAULT '',
  events TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_delivery_at INTEGER,
  last_delivery_status TEXT,
  creator_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_repo_webhooks_repo ON repo_webhooks(repository_id);

-- At-least-once delivery ledger. Receivers must dedupe on the
-- `X-EdgeGit-Delivery` header (the delivery id): request-triggered flushes
-- and the cron sweeper can otherwise deliver twice under concurrency.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  hook_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  event TEXT NOT NULL,
  event_id TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL,
  last_http_status INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (hook_id) REFERENCES repo_webhooks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook_time ON webhook_deliveries(hook_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_repo ON webhook_deliveries(repository_id);
