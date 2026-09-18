import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Star } from 'lucide-react';
import { getStarState, getWatchState, starRepo, unstarRepo, unwatchRepo, watchRepo } from '../../services/socialService';
import { useRealtimeSubscription } from '../../realtime/useRealtime';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';

export type SocialNotice = (type: 'success' | 'error', text: string) => void;

export function useSocialState({
  owner,
  repo,
  authorized,
  showNotice,
}: {
  owner: string;
  repo: string;
  authorized: boolean | null | undefined;
  showNotice: SocialNotice;
}) {
  const { t } = useTranslation();
  const [starsCount, setStarsCount] = useState(0);
  const [starred, setStarred] = useState(false);
  const [watchersCount, setWatchersCount] = useState(0);
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState<'star' | 'watch' | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const [stars, watches] = await Promise.all([getStarState(owner, repo), getWatchState(owner, repo)]);
        if (cancelled) return;
        setStarsCount(stars.starsCount ?? stars.count ?? 0);
        setStarred(stars.viewerStarred);
        setWatchersCount(watches.watchersCount ?? watches.count ?? 0);
        setWatching(watches.viewerWatching);
      } catch {
        // counts stay zero on public-load failure; buttons remain usable
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  const refreshCounts = useCallback(async () => {
    try {
      const [stars, watches] = await Promise.all([getStarState(owner, repo), getWatchState(owner, repo)]);
      setStarsCount(stars.starsCount ?? stars.count ?? 0);
      setWatchersCount(watches.watchersCount ?? watches.count ?? 0);
    } catch {
      // best-effort
    }
  }, [owner, repo]);

  // Live star/watch counts for signed-in viewers.
  useRealtimeSubscription({
    enabled: authorized === true,
    ticket: { kind: 'repo', owner, repo, channels: ['activity'] },
    onEvent: (event) => {
      if (event.type === 'repo.starred' || event.type === 'repo.watching') void refreshCounts();
    },
  });

  const requireAuth = (): boolean => {
    if (authorized !== true) {
      showNotice('error', t('social.signInToStar', 'Sign In To Star Or Watch Repositories.'));
      return false;
    }
    return true;
  };

  const toggleStar = async () => {
    if (busy || !requireAuth()) return;
    setBusy('star');
    try {
      const result = starred ? await unstarRepo(owner, repo) : await starRepo(owner, repo);
      setStarred(result.starred);
      setStarsCount(result.starsCount ?? result.count ?? 0);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('social.failedToStar', 'Failed To Update Star.'));
    } finally {
      setBusy(null);
    }
  };

  const toggleWatch = async () => {
    if (busy || !requireAuth()) return;
    setBusy('watch');
    try {
      const result = watching ? await unwatchRepo(owner, repo) : await watchRepo(owner, repo);
      setWatching(result.watching);
      setWatchersCount(result.watchersCount ?? result.count ?? 0);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('social.failedToWatch', 'Failed To Update Watch.'));
    } finally {
      setBusy(null);
    }
  };

  return { starsCount, starred, watchersCount, watching, busy, toggleStar, toggleWatch };
}

export function StarButton({
  starred,
  starsCount,
  disabled,
  onToggle,
}: {
  starred: boolean;
  starsCount: number;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={starred}
      className={cn(starred && 'text-[var(--color-accent)]')}
    >
      <Star className={cn('h-3.5 w-3.5', starred && 'fill-current')} />
      {starred ? t('social.unstar', 'Unstar') : t('social.star', 'Star')}
      <span className="text-xs text-[var(--color-text-muted)]">{starsCount}</span>
    </Button>
  );
}

export function WatchButton({
  watching,
  watchersCount,
  disabled,
  onToggle,
}: {
  watching: boolean;
  watchersCount: number;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={watching}
      className={cn(watching && 'text-[var(--color-accent)]')}
    >
      <Eye className="h-3.5 w-3.5" />
      {watching ? t('social.unwatch', 'Unwatch') : t('social.watch', 'Watch')}
      <span className="text-xs text-[var(--color-text-muted)]">{watchersCount}</span>
    </Button>
  );
}
