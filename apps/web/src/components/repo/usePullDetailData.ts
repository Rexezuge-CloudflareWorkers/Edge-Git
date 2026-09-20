import { useEffect, useState } from 'react';
import type { MergePreview, PullComment, PullDiff, PullRequest, PullReview } from '../../types';
import { getMergePreview, getPull, getPullDiff, listPullComments, listPullReviews } from '../../services/pullService';
import { fetchUpgraded, useUpgradeFetchState } from '../../lib/upgradeFetch';
import { usePullLive } from '../../realtime/usePullLive';
import { getPullMeta } from '../../services/collabService';

interface UsePullDetailDataArgs {
  owner: string;
  repo: string;
  number: number;
  authorized?: boolean | null;
}

// Data-loading slice for PullDetail (Otter facade pattern): single-flight
// reads across the auth upgrade + live subscription. Extracted so PullDetail
// stays a thin composition root under the god-file guard.
export function usePullDetailData(args: UsePullDetailDataArgs) {
  const { owner, repo, number, authorized } = args;
  const [pull, setPull] = useState<PullRequest | null>(null);
  const [comments, setComments] = useState<PullComment[]>([]);
  const [reviews, setReviews] = useState<PullReview[]>([]);
  const [diff, setDiff] = useState<PullDiff | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [metaLabels, setMetaLabels] = useState<Array<{ name: string }>>([]);

  const useAuthed = authorized === true;
  const pullStateRef = useUpgradeFetchState<PullRequest>();
  const commentsStateRef = useUpgradeFetchState<PullComment[]>();
  const reviewsStateRef = useUpgradeFetchState<PullReview[]>();
  const diffStateRef = useUpgradeFetchState<PullDiff | null>();
  const previewStateRef = useUpgradeFetchState<MergePreview | null>();

  useEffect(() => {
    const key = `${owner}/${repo}/${number}`;
    const authOpt = useAuthed ? { isAuthed: true as const } : { isAuthed: false as const };
    let cancelled = false;
    const run = async () => {
      let pullRes;
      try {
        pullRes = await fetchUpgraded(pullStateRef.current, key, () => getPull(owner, repo, number, authOpt));
      } catch {
        if (!cancelled) setStatus('missing');
        return;
      }
      if (cancelled) return;
      if (pullRes.status === 'loaded') {
        setPull(pullRes.data);
        setStatus('ready');
      }
      const [c, r, d] = await Promise.all([
        fetchUpgraded(commentsStateRef.current, `${key}/comments`, () => listPullComments(owner, repo, number, authOpt))
          .then((res) => (res.status === 'loaded' ? res.data : null))
          .catch(() => [] as PullComment[]),
        fetchUpgraded(reviewsStateRef.current, `${key}/reviews`, () => listPullReviews(owner, repo, number, authOpt))
          .then((res) => (res.status === 'loaded' ? res.data : null))
          .catch(() => [] as PullReview[]),
        fetchUpgraded(diffStateRef.current, `${key}/diff`, () => getPullDiff(owner, repo, number, authOpt))
          .then((res) => (res.status === 'loaded' ? res.data : null))
          .catch(() => null),
      ]);
      if (cancelled) return;
      if (c) setComments(c);
      if (r) setReviews(r);
      if (d) setDiff(d);
      try {
        const previewRes = await fetchUpgraded(previewStateRef.current, `${key}/preview`, () =>
          getMergePreview(owner, repo, number, authOpt),
        );
        if (!cancelled && previewRes.status === 'loaded') setPreview(previewRes.data);
      } catch {
        // preview is best-effort
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, number, useAuthed]);

  useEffect(() => {
    if (!useAuthed) return;
    let cancelled = false;
    void getPullMeta(owner, repo, number)
      .then((meta) => {
        if (!cancelled) setMetaLabels(meta.labels ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [owner, repo, number, useAuthed]);

  const { liveStatus, viewers, liveKey } = usePullLive({
    owner,
    repo,
    number,
    useAuthed,
    ready: status === 'ready',
    setPull,
    setComments,
    setReviews,
  });

  return {
    pull,
    setPull,
    comments,
    setComments,
    reviews,
    setReviews,
    diff,
    setDiff,
    preview,
    setPreview,
    status,
    metaLabels,
    liveStatus,
    viewers,
    liveKey,
    useAuthed,
  };
}
