import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Star } from 'lucide-react';
import { getStarState, getWatchState, starRepo, unstarRepo, unwatchRepo, watchRepo } from '../../services/socialService';
import { cn } from '../../lib/utils';

export function SocialButtons({
  owner,
  repo,
  authorized,
  showNotice,
}: {
  owner: string;
  repo: string;
  authorized: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
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

  const base = 'inline-flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1.5 text-sm transition-colors duration-150 hover:bg-[var(--color-surface-3)] disabled:opacity-60';
  return (
    <div className="flex items-center gap-2">
      <button type="button" onClick={() => void toggleStar()} disabled={busy !== null} className={cn(base, starred && 'text-[var(--color-accent)]')} aria-pressed={starred}>
        <Star className={cn('h-3.5 w-3.5', starred && 'fill-current')} />
        {starred ? t('social.unstar', 'Unstar') : t('social.star', 'Star')}
        <span className="text-xs text-[var(--color-text-muted)]">{starsCount}</span>
      </button>
      <button type="button" onClick={() => void toggleWatch()} disabled={busy !== null} className={cn(base, watching && 'text-[var(--color-accent)]')} aria-pressed={watching}>
        <Eye className="h-3.5 w-3.5" />
        {watching ? t('social.unwatch', 'Unwatch') : t('social.watch', 'Watch')}
        <span className="text-xs text-[var(--color-text-muted)]">{watchersCount}</span>
      </button>
    </div>
  );
}
