import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bell } from 'lucide-react';
import type { NotificationItem } from '../types';
import { listNotifications, markAllNotificationsRead, markNotificationRead } from '../services/notificationService';
import { formatTimestamp } from '../lib/format';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { LoadMoreButton } from '../components/shared/LoadMoreButton';
import { RefreshButton } from '../components/shared/RefreshButton';
import { cn } from '../lib/utils';

export function NotificationsView({ showNotice }: { showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const data = await listNotifications({ unreadOnly });
        if (cancelled) return;
        setItems(data.notifications);
        setCursor(data.nextCursor);
        setUnreadCount(data.unreadCount);
      } catch (error) {
        if (!cancelled) showNotice('error', error instanceof Error ? error.message : t('notifications.failedToLoad', 'Failed To Load Notifications.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [showNotice, t, unreadOnly, reloadKey]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await listNotifications({ unreadOnly, cursor });
      setItems((prev) => [...prev, ...data.notifications]);
      setCursor(data.nextCursor);
      setUnreadCount(data.unreadCount);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('notifications.failedToLoad', 'Failed To Load Notifications.'));
    } finally {
      setLoadingMore(false);
    }
  };

  const markRead = async (id: string) => {
    try {
      await markNotificationRead(id);
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, is_read: 1 } : n)));
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('notifications.failedToMark', 'Failed To Mark Notification Read.'));
    }
  };

  const markAll = async () => {
    try {
      await markAllNotificationsRead();
      setItems((prev) => prev.map((n) => ({ ...n, is_read: 1 })));
      setUnreadCount(0);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('notifications.failedToMark', 'Failed To Mark Notification Read.'));
    }
  };

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-4">
      <Card className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 py-4">
        <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">
          {t('notifications.title', 'Notifications')}
          {unreadCount > 0 && <span className="ml-2 text-sm font-normal text-[var(--color-text-muted)]">{t('notifications.unreadCount', '{{count}} Unread', { count: unreadCount })}</span>}
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
            <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} className="accent-[var(--color-accent)]" />
            {t('notifications.unreadOnly', 'Unread Only')}
          </label>
          <Button variant="secondary" size="sm" onClick={() => void markAll()} disabled={unreadCount === 0}>
            {t('notifications.markAllRead', 'Mark All Read')}
          </Button>
          <RefreshButton onRefresh={refresh} loading={loading} />
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('notifications.inbox', 'Inbox')}</CardTitle>
        </CardHeader>
        {loading && items.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">{t('common.loading', 'Loading…')}</p>
        ) : items.length === 0 ? (
          <div className="text-center text-[var(--color-text-muted)] py-10 text-sm">
            <Bell className="h-6 w-6 mx-auto mb-3 text-[var(--color-text-muted)]" />
            {t('notifications.empty', 'No Notifications.')}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {items.map((item) => (
              <li key={item.id} className={cn('py-3 flex items-start justify-between gap-3 first:pt-0 last:pb-0', item.is_read === 0 && 'font-medium')}>
                <div className="min-w-0">
                  <p className="text-sm text-[var(--color-text-primary)] truncate">{item.title}</p>
                  <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                    <Link to={`/${item.full_name}`} className="text-[var(--color-accent)] hover:underline">
                      {item.full_name}
                    </Link>
                    {' · '}
                    {item.actor_email} · {formatTimestamp(item.created_at)}
                  </p>
                </div>
                {item.is_read === 0 && (
                  <Button variant="ghost" size="sm" onClick={() => void markRead(item.id)}>
                    {t('notifications.markRead', 'Mark Read')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {cursor && <LoadMoreButton onLoadMore={() => void loadMore()} loading={loadingMore} />}
      </Card>
    </div>
  );
}
