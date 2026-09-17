import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Webhook as WebhookIcon } from 'lucide-react';
import type { RepoWebhook, WebhookEventName } from '../../types';
import { createWebhook, deleteWebhook, listWebhooks } from '../../services/webhookService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';
import { WebhookRow } from './WebhookRow';
import type { Notice } from './WebhookRow';

const FALLBACK_EVENTS: WebhookEventName[] = ['push', 'issues', 'issue_comment', 'pull_request', 'pull_request_review', 'fork', 'star', 'watch'];

function replaceHook(hooks: RepoWebhook[], updated: RepoWebhook): RepoWebhook[] {
  return hooks.map((h) => (h.id === updated.id ? updated : h));
}

export function WebhooksCard({ owner, repo, showNotice }: { owner: string; repo: string; showNotice: Notice }) {
  const { t } = useTranslation();
  const [hooks, setHooks] = useState<RepoWebhook[]>([]);
  const [availableEvents, setAvailableEvents] = useState<WebhookEventName[]>(FALLBACK_EVENTS);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState('');
  const [secretInput, setSecretInput] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<WebhookEventName[]>(['push']);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [removing, setRemoving] = useState<RepoWebhook | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{ hookId: string; secret: string } | null>(null);
  const [busyHookId, setBusyHookId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const { hooks: list, events } = await listWebhooks(owner, repo);
        if (cancelled) return;
        setHooks(list);
        if (events.length > 0) {
          setAvailableEvents(events.filter((e) => e !== 'ping'));
        }
      } catch (error) {
        if (!cancelled) showNotice('error', error instanceof Error ? error.message : t('webhooks.failedToLoad', 'Failed To Load Webhooks.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, reloadKey, showNotice, t]);

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const toggleEvent = (event: WebhookEventName) => {
    setSelectedEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || selectedEvents.length === 0) {
      showNotice('error', t('webhooks.urlAndEventsRequired', 'A URL And At Least One Event Are Required.'));
      return;
    }
    setSaving(true);
    try {
      const customSecret = secretInput.trim();
      const { hook, secret } = await createWebhook(owner, repo, {
        url: url.trim(),
        events: selectedEvents,
        ...(customSecret !== '' && { secret: customSecret }),
      });
      setHooks((prev) => [...prev, hook]);
      setUrl('');
      setSecretInput('');
      setRevealedSecret({ hookId: hook.id, secret });
      showNotice('success', t('webhooks.hookCreated', 'Webhook Created.'));
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('webhooks.failedToCreate', 'Failed To Create Webhook.'));
    } finally {
      setSaving(false);
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    setBusyHookId(removing.id);
    try {
      await deleteWebhook(owner, repo, removing.id);
      setHooks((prev) => prev.filter((h) => h.id !== removing.id));
      showNotice('success', t('webhooks.hookDeleted', 'Webhook Deleted.'));
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('webhooks.failedToDelete', 'Failed To Delete Webhook.'));
    } finally {
      setBusyHookId(null);
      setRemoving(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <WebhookIcon className="h-4 w-4" />
            {t('webhooks.title', 'Webhooks')}
          </span>
        </CardTitle>
        <RefreshButton onRefresh={refresh} loading={loading} />
      </CardHeader>
      <p className="text-sm text-[var(--color-text-secondary)]">{t('webhooks.description', 'POST Signed JSON Payloads To External URLs On Repository Events. Deliveries Retry With Backoff.')}</p>

      {revealedSecret && (
        <div className="mt-3 rounded-md border border-[var(--color-warning-text)]/40 bg-[var(--color-warning-bg)] p-3">
          <p className="text-sm font-medium text-[var(--color-text-primary)]">{t('webhooks.copySecretOnce', 'Copy This Secret Now — It Will Not Be Shown Again.')}</p>
          <p className="mt-1 font-mono text-sm break-all text-[var(--color-text-primary)]">{revealedSecret.secret}</p>
          <div className="mt-2">
            <Button size="sm" variant="secondary" onClick={() => setRevealedSecret(null)}>
              {t('webhooks.dismissSecret', 'Dismiss')}
            </Button>
          </div>
        </div>
      )}

      <form onSubmit={submit} className="mt-3 space-y-3">
        <div className="flex gap-3 flex-wrap">
          <div className="flex-1 min-w-52">
            <Input
              type="url"
              required
              placeholder={t('webhooks.urlPlaceholder', 'https://example.com/hook')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="w-52">
            <Input
              type="password"
              autoComplete="new-password"
              placeholder={t('webhooks.secretPlaceholder', 'Signing Secret (Optional, Auto-Generated)')}
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
            />
          </div>
          <Button type="submit" variant="primary" size="sm" loading={saving}>
            {t('webhooks.addHook', 'Add Webhook')}
          </Button>
        </div>
        <div className="flex gap-3 flex-wrap">
          {availableEvents.map((event) => (
            <label key={event} className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
              <input
                type="checkbox"
                checked={selectedEvents.includes(event)}
                onChange={() => toggleEvent(event)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              <span className="font-mono">{event}</span>
            </label>
          ))}
        </div>
      </form>

      <ul className="mt-4 divide-y divide-[var(--color-border)]">
        {hooks.map((hook) => (
          <WebhookRow
            key={hook.id}
            owner={owner}
            repo={repo}
            hook={hook}
            busy={busyHookId === hook.id}
            showNotice={showNotice}
            onChanged={(updated) => setHooks((prev) => replaceHook(prev, updated))}
            onDeleted={(target) => setRemoving(target)}
            onSecretRevealed={(hookId, secret) => setRevealedSecret({ hookId, secret })}
          />
        ))}
      </ul>
      {hooks.length === 0 && !loading && <p className="text-sm text-[var(--color-text-muted)] mt-4">{t('webhooks.noHooks', 'No Webhooks Yet.')}</p>}
      <p className="mt-3 text-xs text-[var(--color-text-muted)]">
        {t('webhooks.signingNote', 'Each Webhook Has Its Own Signing Secret (X-EdgeGit-Signature-256). Hooks Auto-Disable After Repeated Failures.')}
      </p>

      {removing && (
        <ConfirmDeleteModal
          title={t('webhooks.deleteHook', 'Delete Webhook')}
          displayName={removing.urlMasked}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoving(null)}
        />
      )}
    </Card>
  );
}
