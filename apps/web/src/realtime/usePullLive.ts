import { useCallback, useState } from 'react';
import type { PullComment, PullRequest, PullReview } from '../types';
import { getPull, listPullComments, listPullReviews } from '../services/pullService';
import { pullChannel } from './protocol';
import { useRealtimeSubscription } from './useRealtime';
import type { RealtimeStatus } from './useRealtime';

// Live comments / reviews / threads for the PR detail view. Refetches
// directly (bypassing the upgrade-fetch single-flight cache) so remote
// changes appear without a manual refresh; thread lists reload via `liveKey`.
export function usePullLive(options: {
  owner: string;
  repo: string;
  number: number;
  useAuthed: boolean;
  ready: boolean;
  setPull: (pull: PullRequest) => void;
  setComments: (comments: PullComment[]) => void;
  setReviews: (reviews: PullReview[]) => void;
}): { liveStatus: RealtimeStatus; viewers: string[]; liveKey: number } {
  const { owner, repo, number, useAuthed, ready, setPull, setComments, setReviews } = options;
  const [liveKey, setLiveKey] = useState(0);

  const refreshLive = useCallback(async () => {
    const auth = useAuthed ? { isAuthed: true as const } : { isAuthed: false as const };
    try {
      const [nextPull, nextComments, nextReviews] = await Promise.all([
        getPull(owner, repo, number, auth).catch(() => null),
        listPullComments(owner, repo, number, auth).catch(() => null),
        listPullReviews(owner, repo, number, auth).catch(() => null),
      ]);
      if (nextPull) setPull(nextPull);
      if (nextComments) setComments(nextComments);
      if (nextReviews) setReviews(nextReviews);
      setLiveKey((k) => k + 1);
    } catch {
      // best-effort
    }
  }, [owner, repo, number, useAuthed, setPull, setComments, setReviews]);

  const { status: liveStatus, viewers } = useRealtimeSubscription({
    enabled: useAuthed && ready,
    ticket: { kind: 'repo', owner, repo, channels: [pullChannel(number), 'presence'] },
    onEvent: (event) => {
      if (!event.type.startsWith('pull_') && !event.type.startsWith('pr_')) return;
      void refreshLive();
    },
  });

  return { liveStatus, viewers, liveKey };
}
