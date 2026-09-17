import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Activity } from 'lucide-react';
import type { RepoEvent } from '../../types';
import { listActivity } from '../../services/socialService';
import { formatTimestamp } from '../../lib/format';
import { Card } from '../ui/Card';
import { LoadMoreButton } from '../shared/LoadMoreButton';
import { RefreshButton } from '../shared/RefreshButton';

const EVENT_LABELS: Record<string, string> = {
  repo_created: 'Created This Repository',
  push: 'Pushed Commits',
  issue_opened: 'Opened An Issue',
  issue_closed: 'Closed An Issue',
  issue_reopened: 'Reopened An Issue',
  issue_commented: 'Commented On An Issue',
  pr_opened: 'Opened A Pull Request',
  pr_closed: 'Closed A Pull Request',
  pr_merged: 'Merged A Pull Request',
  pr_reviewed: 'Reviewed A Pull Request',
  pr_commented: 'Commented On A Pull Request',
  fork_created: 'Forked This Repository',
  release_created: 'Created A Release',
  release_published: 'Published A Release',
  project_created: 'Created A Project',
  project_closed: 'Closed A Project',
  project_reopened: 'Reopened A Project',
  discussion_opened: 'Opened A Discussion',
  discussion_answered: 'Answered A Discussion',
  discussion_locked: 'Locked A Discussion',
  discussion_commented: 'Commented On A Discussion',
  wiki_created: 'Created A Wiki Page',
  wiki_updated: 'Updated A Wiki Page',
  snippet_created: 'Created A Snippet',
};

function eventTarget(event: RepoEvent): string | null {
  if (event.subject_type === 'issue' && event.subject_number !== null) return `Issue #${event.subject_number}`;
  if (event.subject_type === 'pull' && event.subject_number !== null) return `Pull #${event.subject_number}`;
  if (event.subject_type === 'release') {
    try {
      const payload = JSON.parse(event.payload ?? '{}') as { tag?: string };
      if (typeof payload.tag === 'string' && payload.tag) return payload.tag;
    } catch {
      // ignore
    }
    return 'Release';
  }
  if (event.type === 'push' && event.subject_oid) return event.subject_oid.slice(0, 7);
  return null;
}

function eventDetail(event: RepoEvent): string | null {
  try {
    const payload = JSON.parse(event.payload ?? '{}') as { refs?: string[]; count?: number; fork?: string };
    if (event.type === 'push' && Array.isArray(payload.refs) && payload.refs.length > 0) return payload.refs.slice(0, 3).join(', ');
    if (event.type === 'fork_created' && typeof payload.fork === 'string') return `→ ${payload.fork}`;
  } catch {
    // payload is opaque; ignore parse failures
  }
  return null;
}

export function ActivityTab({ owner, repo, showNotice }: { owner: string; repo: string; showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<RepoEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const data = await listActivity(owner, repo);
        if (cancelled) return;
        setEvents(data.events);
        setCursor(data.nextCursor);
      } catch (error) {
        if (!cancelled) showNotice('error', error instanceof Error ? error.message : t('social.failedToLoadActivity', 'Failed To Load Activity.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, showNotice, t, reloadKey]);

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await listActivity(owner, repo, cursor);
      setEvents((prev) => [...prev, ...data.events]);
      setCursor(data.nextCursor);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('social.failedToLoadActivity', 'Failed To Load Activity.'));
    } finally {
      setLoadingMore(false);
    }
  };

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-[var(--color-text-primary)]">{t('social.activity', 'Activity')}</h2>
        <RefreshButton onRefresh={refresh} loading={loading} />
      </div>
      {loading && events.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">{t('common.loading', 'Loading…')}</p>
      ) : events.length === 0 ? (
        <div className="text-center text-[var(--color-text-muted)] py-10 text-sm">
          <Activity className="h-6 w-6 mx-auto mb-3 text-[var(--color-text-muted)]" />
          {t('social.noActivity', 'No Activity Yet.')}
        </div>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {events.map((event) => (
            <li key={event.id} className="py-3 first:pt-0 last:pb-0">
              <p className="text-sm text-[var(--color-text-primary)]">
                <span className="font-medium">{event.actor_email}</span> <span className="text-[var(--color-text-secondary)]">{t(`social.events.${event.type}`, EVENT_LABELS[event.type] ?? event.type)}</span>{' '}
                {eventTarget(event) && <span className="font-medium">{eventTarget(event)}</span>}
              </p>
              <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                {eventDetail(event) ? `${eventDetail(event)} · ` : ''}
                {formatTimestamp(event.created_at)}
              </p>
              {event.subject_type === 'issue' && event.subject_number !== null && (
                <Link to={`/${owner}/${repo}/issues/${event.subject_number}`} className="mt-0.5 inline-block text-xs text-[var(--color-accent)] hover:underline">
                  {t('social.viewIssue', 'View Issue #{{number}}', { number: event.subject_number })}
                </Link>
              )}
              {event.subject_type === 'pull' && event.subject_number !== null && (
                <Link to={`/${owner}/${repo}/pulls/${event.subject_number}`} className="mt-0.5 inline-block text-xs text-[var(--color-accent)] hover:underline">
                  {t('social.viewPull', 'View Pull #{{number}}', { number: event.subject_number })}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      {cursor && <LoadMoreButton onLoadMore={() => void loadMore()} loading={loadingMore} />}
    </Card>
  );
}
