import { useEffect, useRef, useState } from 'react';
import type { Repo } from '../types';
import { getBackendErrorStatus } from '../lib/api';
import { loadRepoAuthed, loadRepoPublic } from '../services/repoService';

export type RepoShellStatus = 'loading' | 'ready' | 'missing' | 'forbidden';

// Shared repo shell loader for detail views (commit, compare, history):
// speculative public first, upgrade to authed when signed in. `null` and
// `false` share the public path so null->false never refetches; a public
// 404 while resolving is parked and applied on settle without refetch.
export function useRepoData(owner: string, repo: string, authorized: boolean | null): { status: RepoShellStatus; repoData: Repo | null } {
  const [repoData, setRepoData] = useState<Repo | null>(null);
  const [status, setStatus] = useState<RepoShellStatus>('loading');
  const useAuthed = authorized === true;
  const pendingErrorRef = useRef<{ key: string; kind: RepoShellStatus } | null>(null);

  useEffect(() => {
    pendingErrorRef.current = null;
    let cancelled = false;
    const run = async () => {
      if (useAuthed) {
        try {
          const data = await loadRepoAuthed(owner, repo);
          if (!cancelled) {
            setRepoData(data);
            setStatus('ready');
          }
          return;
        } catch {
          // Fall through to public.
        }
      }
      try {
        const data = await loadRepoPublic(owner, repo);
        if (!cancelled) {
          setRepoData(data);
          setStatus('ready');
        }
      } catch (error) {
        if (cancelled) return;
        const kind: RepoShellStatus = getBackendErrorStatus(error) === 404 ? 'missing' : 'forbidden';
        if (authorized === null) {
          pendingErrorRef.current = { key: `${owner}/${repo}`, kind };
          return;
        }
        setStatus(kind);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, useAuthed]);

  useEffect(() => {
    if (authorized !== false || status !== 'loading' || repoData) return;
    const pending = pendingErrorRef.current;
    if (pending && pending.key === `${owner}/${repo}`) {
      setStatus(pending.kind);
      pendingErrorRef.current = null;
    }
  }, [authorized, status, repoData, owner, repo]);

  return { status, repoData };
}
