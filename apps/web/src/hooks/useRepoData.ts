import { useEffect, useState } from 'react';
import type { Repo } from '../types';
import { loadRepoAuthed, loadRepoPublic } from '../services/repoService';

export type RepoShellStatus = 'loading' | 'ready' | 'missing' | 'forbidden';

// Shared repo shell loader for detail views (commit, compare, history):
// authenticated first, then anonymous public. Private repos report
// `forbidden` so callers can render the sign-in gate.
export function useRepoData(owner: string, repo: string, authorized: boolean | null): { status: RepoShellStatus; repoData: Repo | null } {
  const [repoData, setRepoData] = useState<Repo | null>(null);
  const [status, setStatus] = useState<RepoShellStatus>('loading');

  useEffect(() => {
    if (authorized === null) return;
    let cancelled = false;
    const run = async () => {
      if (authorized) {
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
        const message = error instanceof Error ? error.message : '';
        setStatus(message.includes('404') || message.includes('Not found') ? 'missing' : 'forbidden');
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, authorized]);

  return { status, repoData };
}
