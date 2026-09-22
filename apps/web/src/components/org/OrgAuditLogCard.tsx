import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuditLogEntry } from '../../types';
import { loadOrgAudit } from '../../services/teamService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { Input } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

const PAGE_SIZE = 25;

function statusVariant(status: number): 'success' | 'warning' | 'error' {
  if (status < 300) return 'success';
  if (status < 400) return 'warning';
  return 'error';
}

export function OrgAuditLogCard({ org, showNotice }: { org: string; showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [username, setUsername] = useState('');
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState({ username: '', action: '' });
  const [reloadKey, setReloadKey] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const data = await loadOrgAudit(org, {
          username: applied.username.trim() || undefined,
          action: applied.action.trim() || undefined,
          limit: PAGE_SIZE,
        });
        if (!cancelled) {
          setLogs(data.logs);
          setNextCursor(data.nextCursor);
        }
      } catch (error) {
        if (!cancelled) showNotice('error', toLocalizedErrorMessage(t, error, 'audit.failedToLoad', 'Failed To Load Audit Log.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [org, applied, reloadKey, showNotice, t]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const data = await loadOrgAudit(org, {
        username: applied.username.trim() || undefined,
        action: applied.action.trim() || undefined,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      setLogs((prev) => [...prev, ...data.logs]);
      setNextCursor(data.nextCursor);
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'audit.failedToLoad', 'Failed To Load Audit Log.'));
    } finally {
      setLoadingMore(false);
    }
  };

  const search = (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setLogs([]);
    setNextCursor(null);
    setApplied({ username, action });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('audit.title', 'Audit Log')}</CardTitle>
        <RefreshButton
          onRefresh={() => {
            setLoading(true);
            setReloadKey((k) => k + 1);
          }}
          loading={loading}
        />
      </CardHeader>
      <form onSubmit={search} className="flex gap-3 flex-wrap mb-4">
        <div className="flex-1 min-w-48">
          <Input placeholder={t('audit.userPlaceholder', 'Username')} value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="flex-1 min-w-48">
          <Input
            placeholder={t('audit.actionPlaceholder', 'Action, e.g. PUSH')}
            value={action}
            onChange={(e) => setAction(e.target.value)}
          />
        </div>
        <Button type="submit" variant="primary" size="sm">
          {t('audit.search', 'Search')}
        </Button>
      </form>
      <ul className="divide-y divide-[var(--color-border)]">
        {logs.map((log) => (
          <li key={log.id} className="py-3 first:pt-0 last:pb-0">
            <button
              type="button"
              className="w-full text-left flex items-center gap-3"
              onClick={() => setExpanded((cur) => (cur === log.id ? null : log.id))}
            >
              <span className="text-xs text-[var(--color-text-muted)] shrink-0 w-36 truncate">
                {new Date(log.timestamp * 1000).toLocaleString()}
              </span>
              <span className="text-sm text-[var(--color-text-primary)] truncate flex-1 min-w-0">{log.username}</span>
              <span className="text-sm font-medium shrink-0">{log.action}</span>
              <Badge variant={statusVariant(log.statusCode)}>{log.statusCode}</Badge>
            </button>
            {expanded === log.id && (
              <dl className="mt-2 text-xs text-[var(--color-text-muted)] space-y-1 break-all">
                <div className="flex gap-2">
                  <dt className="shrink-0 font-medium">{t('audit.path', 'Path')}:</dt>
                  <dd>
                    {log.method} {log.path}
                  </dd>
                </div>
                {log.resource && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-medium">{t('audit.resource', 'Resource')}:</dt>
                    <dd>{log.resource}</dd>
                  </div>
                )}
                {log.ipAddress && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-medium">{t('audit.ip', 'IP')}:</dt>
                    <dd>{log.ipAddress}</dd>
                  </div>
                )}
                {log.userAgent && (
                  <div className="flex gap-2">
                    <dt className="shrink-0 font-medium">{t('audit.userAgent', 'User Agent')}:</dt>
                    <dd>{log.userAgent}</dd>
                  </div>
                )}
              </dl>
            )}
          </li>
        ))}
      </ul>
      {logs.length === 0 && !loading && (
        <p className="text-sm text-[var(--color-text-muted)] mt-4">{t('audit.empty', 'No Audit Entries Yet.')}</p>
      )}
      {nextCursor && (
        <div className="mt-4">
          <Button variant="secondary" size="sm" loading={loadingMore} onClick={() => void loadMore()}>
            {t('common.loadMore', 'Load More')}
          </Button>
        </div>
      )}
    </Card>
  );
}
