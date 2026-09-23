import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, Star } from 'lucide-react';
import { getStarState, getWatchState, starRepo, unstarRepo, unwatchRepo, watchRepo } from '../../services/socialService';
import type { Repo } from '../../types';
import { useRealtimeSubscription } from '../../realtime/useRealtime';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

export type SocialNotice = (type: 'success' | 'error', text: string) => void;

type SocialSeed = Pick<Repo, 'starsCount' | 'watchersCount' | 'viewerStarred' | 'viewerWatching' | 'starred' | 'watching'>;

export function useSocialState({
  owner,
  repo,
  authorized,
  showNotice,
  initial,
}: {
  owner: string;
  repo: string;
  authorized: boolean | null | undefined;
  showNotice: SocialNotice;
  // Repo payload seed: the enriched `GET /repos|/user/repos/:owner/:repo`
  // already carries counts + viewer flags, so the buttons render without
  // separate star/watch round-trips. Absent on older backends — falls back
  // to fetching below.
  initial?: SocialSeed | null;
}) {
  const { t } = useTranslation();
  const [starsCount, setStarsCount] = useState(initial?.starsCount ?? 0);
  const [starred, setStarred] = useState(initial?.viewerStarred ?? initial?.starred ?? false);
  const [watchersCount, setWatchersCount] = useState(initial?.watchersCount ?? 0);
  const [watching, setWatching] = useState(initial?.viewerWatching ?? initial?.watching ?? false);
  const [busy, setBusy] = useState<'star' | 'watch' | null>(null);

  // `true` only for signed-in viewers: `null` (resolving) and `false` share
  // the public path so null->false never refetches, while null/false->true
  // refetches via the authed per-repo status (`GET /user/.../star|watch`)
  // so viewerStarred/viewerWatching resolve with Access auth instead of the
  // best-effort public read-model. When the repo payload already carries the
  // social read-model (enriched `GET /repos|/user/repos/:owner/:repo`), the
  // seed below applies instead and no fetch runs at all.
  const useAuthed = authorized === true;
  const authOpt = useAuthed ? { isAuthed: true as const } : { isAuthed: false as const };
  const seedStars = initial?.starsCount;
  const seedWatchers = initial?.watchersCount;
  const seedStarred = initial?.viewerStarred ?? initial?.starred;
  const seedWatching = initial?.viewerWatching ?? initial?.watching;
  const hasSeed = seedStars !== undefined || seedWatchers !== undefined;

  // Seed from the repo payload during render (previous-value pattern): the
  // public→authed repo upgrade applies without a fetch and without sync
  // setState in an effect. Toggles/realtime keep working — they setState
  // from event callbacks, and the next seed only applies when the payload
  // itself changes.
  const seedKey = hasSeed
    ? `${owner}/${repo}/${seedStars ?? 0}/${seedWatchers ?? 0}/${seedStarred ?? false}/${seedWatching ?? false}`
    : null;
  const [appliedSeedKey, setAppliedSeedKey] = useState<string | null>(null);
  if (seedKey !== appliedSeedKey) {
    setAppliedSeedKey(seedKey);
    setStarsCount(seedStars ?? 0);
    setStarred(seedStarred ?? false);
    setWatchersCount(seedWatchers ?? 0);
    setWatching(seedWatching ?? false);
  }

  useEffect(() => {
    if (hasSeed) return;
    let cancelled = false;
    const run = async () => {
      try {
        const [stars, watches] = await Promise.all([getStarState(owner, repo, authOpt), getWatchState(owner, repo, authOpt)]);
        if (cancelled) return;
        setStarsCount(stars.starsCount ?? stars.count ?? 0);
        setStarred(stars.viewerStarred ?? stars.starred ?? false);
        setWatchersCount(watches.watchersCount ?? watches.count ?? 0);
        setWatching(watches.viewerWatching ?? watches.watching ?? false);
      } catch {
        // counts stay zero on public-load failure; buttons remain usable.
        // A private-repo 404 while anonymous retries after auth upgrade via
        // `useAuthed`.
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, useAuthed, hasSeed]);

  const refreshCounts = useCallback(async () => {
    try {
      const [stars, watches] = await Promise.all([getStarState(owner, repo, authOpt), getWatchState(owner, repo, authOpt)]);
      setStarsCount(stars.starsCount ?? stars.count ?? 0);
      setStarred(stars.viewerStarred ?? stars.starred ?? false);
      setWatchersCount(watches.watchersCount ?? watches.count ?? 0);
      setWatching(watches.viewerWatching ?? watches.watching ?? false);
    } catch {
      // best-effort
    }
  }, [owner, repo, useAuthed]);

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
      showNotice('error', toLocalizedErrorMessage(t, error, 'social.failedToStar', 'Failed To Update Star.'));
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
      showNotice('error', toLocalizedErrorMessage(t, error, 'social.failedToWatch', 'Failed To Update Watch.'));
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
