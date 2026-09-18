import { useEffect, useRef, useState } from 'react';
import type { GitCommit, OverviewResponse, TagInfo, TreeEntry } from '../../types';
import { decodeBlobContent, loadOverview, loadTree } from '../../services/repoService';

function resolveSelectedRef(ref: string, branches: string[], currentBranch: string | null, tagRefs: Set<string>): string {
  const isKnownRef = (ref.startsWith('refs/tags/') && tagRefs.has(ref)) || (ref !== '' && branches.includes(ref));
  return isKnownRef ? ref : (currentBranch ?? branches[0] ?? 'HEAD');
}

function mergeEnrichedEntries(prev: TreeEntry[], enriched: TreeEntry[]): TreeEntry[] {
  if (prev.length !== enriched.length) return enriched;
  const byKey = new Map(enriched.map((e) => [`${e.oid}:${e.path}`, e.lastCommit ?? null]));
  let changed = false;
  const next = prev.map((e) => {
    const lc = byKey.get(`${e.oid}:${e.path}`);
    if (lc && !e.lastCommit) {
      changed = true;
      return { ...e, lastCommit: lc };
    }
    return e;
  });
  return changed ? next : prev;
}

interface CodeTabOverview {
  branches: string[];
  defaultBranch: string | null;
  tags: TagInfo[];
  entries: TreeEntry[];
  commits: GitCommit[];
  readme: { path: string; text: string } | null;
  loading: boolean;
  reloadKey: number;
  setRef: (ref: string) => void;
  setEntries: React.Dispatch<React.SetStateAction<TreeEntry[]>>;
  setLoading: (loading: boolean) => void;
  setReloadKey: React.Dispatch<React.SetStateAction<number>>;
  setBranches: React.Dispatch<React.SetStateAction<string[]>>;
}

/**
 * Overview data slice extracted from `CodeTab` (500 LOC god-file).
 * Owns the aggregate overview DO RPC + lazy last-commit enrichment + inflight
 * sharing so auth upgrades never double-fetch. The component keeps only
 * selection state + rendering.
 */
function useCodeTabOverview(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  useAuthed: boolean,
  showNotice: (type: 'success' | 'error', text: string) => void,
): CodeTabOverview & { refState: [string, React.Dispatch<React.SetStateAction<string>>] } {
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [tags, setTags] = useState<TagInfo[]>([]);
  // Controlled selection lives in the caller (`CodeTab` owns `ref`); the hook
  // exposes `setRef` passthrough so future callers can migrate incrementally
  // without a set-state-in-effect sync.
  const [refState, setRef] = useState(ref);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [readme, setReadme] = useState<{ path: string; text: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const overviewStateRef = useRef<{
    key: string | null;
    inflightKey: string | null;
    inflight: Promise<OverviewResponse> | null;
    enrichedKey: string | null;
    enrichInflightKey: string | null;
    enrichInflight: Promise<TreeEntry[]> | null;
  }>({ key: null, inflightKey: null, inflight: null, enrichedKey: null, enrichInflightKey: null, enrichInflight: null });

  useEffect(() => {
    let cancelled = false;
    const authOpt = useAuthed ? { isAuthed: true as const } : { isAuthed: false as const };
    const run = async () => {
      const key = `${owner}/${repo}/${refState}/${path}/${reloadKey}`;
      const st = overviewStateRef.current;
      if (st.key === key) return;
      try {
        const shared = st.inflightKey === key ? st.inflight : null;
        let overview: OverviewResponse | null = null;
        if (shared) {
          try {
            overview = await shared;
          } catch {
            overview = null;
          }
          if (cancelled) return;
        }
        if (!overview) {
          const promise = loadOverview(owner, repo, refState || undefined, path || undefined, { ...authOpt, depth: 10 });
          st.inflightKey = key;
          st.inflight = promise;
          try {
            overview = await promise;
          } finally {
            if (st.inflight === promise) {
              st.inflight = null;
              st.inflightKey = null;
            }
          }
          if (cancelled) return;
        }
        st.key = key;
        setBranches(overview.branches);
        setDefaultBranch(overview.currentBranch ?? overview.branches[0] ?? null);
        setTags(overview.tags);
        const tagRefs = new Set(overview.tags.map((tg) => tg.ref));
        const resolvedRef = resolveSelectedRef(refState, overview.branches, overview.currentBranch ?? overview.branches[0] ?? null, tagRefs);
        if (refState !== '' && resolvedRef !== refState) {
          setRef(resolvedRef === 'HEAD' ? '' : resolvedRef);
          return;
        }
        const effectiveRef = resolvedRef;
        const treeRef = effectiveRef === 'HEAD' ? undefined : effectiveRef;
        const dir = path || undefined;
        setEntries(overview.tree);
        setCommits(overview.commits);
        const isBinaryReadme = overview.readme?.isBinary ?? false;
        const readmeText = isBinaryReadme ? null : decodeBlobContent(overview.readme ?? null);
        setReadme(readmeText !== null && overview.readme ? { path: overview.readme.path, text: readmeText } : null);
        setLoading(false);
        const enrichKey = `${key}/${treeRef ?? ''}/${dir ?? ''}`;
        if (st.enrichedKey !== enrichKey) {
          const sharedEnrich = st.enrichInflightKey === enrichKey ? st.enrichInflight : null;
          let enriched: TreeEntry[] | null = null;
          if (sharedEnrich) {
            try {
              enriched = await sharedEnrich;
            } catch {
              enriched = null;
            }
          } else {
            st.enrichInflightKey = enrichKey;
            const enrichPromise = loadTree(owner, repo, treeRef, dir, { ...authOpt, withLastCommit: true });
            st.enrichInflight = enrichPromise;
            try {
              enriched = await enrichPromise;
            } catch {
              enriched = null;
            } finally {
              if (st.enrichInflight === enrichPromise) {
                st.enrichInflight = null;
                st.enrichInflightKey = null;
              }
            }
          }
          if (cancelled) return;
          if (enriched) {
            st.enrichedKey = enrichKey;
            setEntries((prev) => mergeEnrichedEntries(prev, enriched));
          }
        }
      } catch (error) {
        if (!cancelled) showNotice('error', error instanceof Error ? error.message : 'Failed To Load Repository Files.');
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, refState, path, showNotice, reloadKey, useAuthed]);

  return {
    branches,
    defaultBranch,
    tags,
    entries,
    commits,
    readme,
    loading,
    reloadKey,
    setRef,
    setEntries,
    setLoading,
    setReloadKey,
    setBranches,
    refState: [refState, setRef],
  };
}

export { useCodeTabOverview, resolveSelectedRef, mergeEnrichedEntries };
