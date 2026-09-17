import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RepoWebhook, WebhookDelivery } from '../../types';
import { listWebhookDeliveries, redeliverWebhook, rotateWebhookSecret, testWebhook, updateWebhook } from '../../services/webhookService';
import { formatTimestamp } from '../../lib/format';
import { Button } from '../ui/Button';

export type Notice = (type: 'success' | 'error', text: string) => void;

export function DeliveryStatusBadge({ status }: { status: WebhookDelivery['status'] }) {
  const { t } = useTranslation();
  const label =
    status === 'success'
      ? t('webhooks.delivered', 'Delivered')
      : status === 'failed'
        ? t('webhooks.failed', 'Failed')
        : t('webhooks.pending', 'Pending');
  const tone =
    status === 'success'
      ? 'text-[var(--color-success-text)] border-[var(--color-success-text)]/40'
      : status === 'failed'
        ? 'text-[var(--color-error-text)] border-[var(--color-error-text)]/40'
        : 'text-[var(--color-text-muted)] border-[var(--color-border)]';
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${tone}`}>{label}</span>;
}

async function runHookAction(showNotice: Notice, successMessage: string, failureMessage: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    showNotice('success', successMessage);
  } catch (error) {
    showNotice('error', error instanceof Error ? error.message : failureMessage);
  }
}

export function WebhookRow({
  owner,
  repo,
  hook,
  busy,
  showNotice,
  onChanged,
  onDeleted,
  onSecretRevealed,
}: {
  owner: string;
  repo: string;
  hook: RepoWebhook;
  busy: boolean;
  showNotice: Notice;
  onChanged: (hook: RepoWebhook) => void;
  onDeleted: (hook: RepoWebhook) => void;
  onSecretRevealed: (hookId: string, secret: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);
  const [working, setWorking] = useState(false);
  const disabled = busy || working;

  const withWorking = async (action: () => Promise<unknown>): Promise<void> => {
    setWorking(true);
    try {
      await action();
    } finally {
      setWorking(false);
    }
  };

  const loadDeliveries = async (): Promise<void> => {
    setExpanded(true);
    setLoadingDeliveries(true);
    try {
      const { deliveries: rows } = await listWebhookDeliveries(owner, repo, hook.id);
      setDeliveries(rows);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('webhooks.failedToLoadDeliveries', 'Failed To Load Deliveries.'));
    } finally {
      setLoadingDeliveries(false);
    }
  };

  const toggleActive = () =>
    void withWorking(() =>
      runHookAction(
        showNotice,
        t(hook.isActive ? 'webhooks.disabled' : 'webhooks.enabled', hook.isActive ? 'Webhook Disabled.' : 'Webhook Enabled.'),
        t('webhooks.actionFailed', 'Webhook Action Failed.'),
        async () => {
          const { hook: updated } = await updateWebhook(owner, repo, hook.id, { isActive: !hook.isActive });
          onChanged(updated);
        },
      ),
    );

  const sendTest = () =>
    void withWorking(() =>
      runHookAction(
        showNotice,
        t('webhooks.testSent', 'Test Ping Sent. See Delivery History.'),
        t('webhooks.actionFailed', 'Webhook Action Failed.'),
        async () => {
          await testWebhook(owner, repo, hook.id);
          await loadDeliveries();
        },
      ),
    );

  const rotateSecret = () =>
    void withWorking(async () => {
      try {
        const { hook: updated, secret } = await rotateWebhookSecret(owner, repo, hook.id);
        onChanged(updated);
        onSecretRevealed(hook.id, secret);
        showNotice('success', t('webhooks.secretRotated', 'Webhook Secret Rotated.'));
      } catch (error) {
        showNotice('error', error instanceof Error ? error.message : t('webhooks.actionFailed', 'Webhook Action Failed.'));
      }
    });

  const toggleHistory = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    void loadDeliveries();
  };

  const redeliver = (delivery: WebhookDelivery) =>
    void withWorking(async () => {
      try {
        await redeliverWebhook(owner, repo, hook.id, delivery.id);
        showNotice('success', t('webhooks.redelivered', 'Delivery Queued For Redelivery.'));
        await loadDeliveries();
      } catch (error) {
        showNotice('error', error instanceof Error ? error.message : t('webhooks.actionFailed', 'Webhook Action Failed.'));
      }
    });

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="font-medium font-mono text-[var(--color-text-primary)] truncate">{hook.urlMasked}</p>
          <p className="text-xs text-[var(--color-text-muted)]">
            {hook.events.join(', ')}
            {' · '}
            {hook.lastDeliveryAt
              ? hook.lastDeliveryStatus === 'success'
                ? t('webhooks.lastDelivered', 'Last Delivered {{date}}', { date: formatTimestamp(hook.lastDeliveryAt) })
                : t('webhooks.lastFailed', 'Last Failed {{date}} ({{count}} Consecutive)', {
                    date: formatTimestamp(hook.lastDeliveryAt),
                    count: hook.consecutiveFailures,
                  })
              : t('webhooks.neverDelivered', 'Never Delivered')}
            {!hook.isActive && ` · ${t('webhooks.disabledBadge', 'Disabled')}`}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="secondary" loading={disabled} onClick={toggleHistory}>
            {t('webhooks.history', 'History')}
          </Button>
          <Button size="sm" variant="secondary" loading={disabled} onClick={sendTest}>
            {t('webhooks.test', 'Test')}
          </Button>
          <Button size="sm" variant="secondary" loading={disabled} onClick={toggleActive}>
            {hook.isActive ? t('webhooks.disable', 'Disable') : t('webhooks.enable', 'Enable')}
          </Button>
          <Button size="sm" variant="secondary" loading={disabled} onClick={rotateSecret}>
            {t('webhooks.rotateSecret', 'Rotate Secret')}
          </Button>
          <Button size="sm" variant="danger" onClick={() => onDeleted(hook)}>
            {t('common.delete', 'Delete')}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="mt-2 rounded-md border border-[var(--color-border)] p-2">
          {loadingDeliveries && <p className="text-sm text-[var(--color-text-muted)]">{t('common.loading', 'Loading…')}</p>}
          {!loadingDeliveries && deliveries.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">{t('webhooks.noDeliveries', 'No Deliveries Yet.')}</p>}
          <ul className="divide-y divide-[var(--color-border)]">
            {deliveries.map((delivery) => (
              <li key={delivery.id} className="py-2 flex items-center justify-between gap-3 first:pt-0 last:pb-0 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm text-[var(--color-text-primary)]">
                    <span className="font-mono">{delivery.event}</span> · {formatTimestamp(delivery.createdAt)} ·{' '}
                    {t('webhooks.attempts', '{{count}} Attempts', { count: delivery.attempts })}
                    {delivery.lastHttpStatus ? ` · HTTP ${delivery.lastHttpStatus}` : ''}
                  </p>
                  {delivery.lastError && <p className="font-mono text-xs text-[var(--color-error-text)] truncate">{delivery.lastError}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <DeliveryStatusBadge status={delivery.status} />
                  <Button size="sm" variant="secondary" loading={disabled} onClick={() => redeliver(delivery)}>
                    {t('webhooks.redeliver', 'Redeliver')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
