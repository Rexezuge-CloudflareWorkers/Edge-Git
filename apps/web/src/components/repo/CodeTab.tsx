import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { GitCommit, OverviewResponse, Repo, TagInfo, TreeEntry } from '../../types';
import { decodeBlobContent, loadBlob, loadOverview, loadTree } from '../../services/repoService';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';
import { readParam, writeParams } from '../../lib/urlParams';
import { resolveSelectedRef, mergeEnrichedEntries } from './useCodeTabOverview';
import { findReadmeEntry, isEditableSize } from './codeTabUtils';
import { useSocialState } from './SocialButtons';
import { BlobView } from './BlobView';
import { FileBrowser } from './FileBrowser';
import { ReadmeCard } from './ReadmeCard';
import { CodeTabToolbar } from './CodeTabToolbar';
import { CodeTabSidebar } from './CodeTabSidebar';

export function CodeTab({
  owner,
  repo,
  repoMeta,
  canWrite,
  forkOwner,
  showNotice,
  authorized,
}: {
  owner: string;
  repo: string;
  repoMeta: Repo;
  canWrite: boolean;
  forkOwner: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
  authorized?: boolean | null;
}) {
  const social = useSocialState({ owner, repo, authorized, showNotice });
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [tags, setTags] = useState<TagInfo[]>([]);
  // Branch / directory / open file are URL state (`?ref=&path=&blob=`) with
  // the URL as the single source of truth: every navigation writes the query
  // directly, so pasted links, Back, and clicks can never disagree. Blob
  // bytes and edit drafts stay local (fetch cache, never shared).
  const ref = readParam(params, 'ref');
  const path = readParam(params, 'path');
  const blobPath = readParam(params, 'blob') || null;
  // Omitted keys keep their current value; `''`/`null` clears the key.
  const navigateBrowser = (patch: { ref?: string; path?: string; blob?: string | null }) => {
    writeParams(setParams, params, {
      ref: patch.ref ?? ref,
      path: patch.path ?? path,
      blob: patch.blob === undefined ? (blobPath ?? '') : (patch.blob ?? ''),
    });
  };
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [blobText, setBlobText] = useState<string | null>(null);
  const [blobBinary, setBlobBinary] = useState(false);
  // Which blob the byte cache belongs to; while a different file loads, the
  // UI shows nothing rather than the previous file's content. Plain state
  // (not a ref) so render may read it.
  const [loadedBlob, setLoadedBlob] = useState<string | null>(null);
  const [readme, setReadme] = useState<{ path: string; text: string } | null>(null);
  // Edit/create targets are paths, not booleans, so navigating to another
  // ref, directory, or file hides the forms without a reset effect.
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [createDir, setCreateDir] = useState<string | null>(null);

  const [reloadKey, setReloadKey] = useState(0);

  // `ref` is the explicit user selection (`''` = follow the default branch).
  // `selectedRef` is what is displayed and used for fetching, so the dropdown
  // shows the actual branch name (e.g. `main`) instead of a generic placeholder.
  const selectedRef = ref || defaultBranch || branches[0] || '';
  const emptyBranchesLabel = loading ? t('branches.loading', 'Loading…') : t('branches.noBranches', 'No Branches');
  const placeholderLabel = branches.length === 0 ? emptyBranchesLabel : selectedRef;
  // Web writes target branches only — tag refs are immutable snapshots.
  const isTagRef = ref.startsWith('refs/tags/');
  const editable = canWrite && !isTagRef && selectedRef !== '';
  const branchTip = commits[0]?.oid;
  // Bytes belong to `loadedBlob`; while a different file loads, show
  // nothing rather than the previous file's content.
  const blobSettled = loadedBlob === blobPath;
  const visibleBlobText = blobSettled ? blobText : null;
  const visibleBlobBinary = blobSettled ? blobBinary : false;
  // Edit unlocks only once this file's bytes arrive: opening the editor on
  // a blank buffer could save empty content over the real file.
  const editableFile = editable && blobSettled && !visibleBlobBinary && isEditableSize((visibleBlobText ?? '').length);

  // `true` only for signed-in viewers: `null` (resolving) and `false`
  // share the public path so null->false never refetches.
  const useAuthed = authorized === true;
  // Public and authed overview are the same DO payload for repos the public
  // endpoint can serve, so an auth upgrade (null->true) must not refetch a
  // key that already loaded (or is still loading) publicly. `key` is the last
  // successful key, `enrichedKey` the last enriched one; inflight promises are
  // shared instead of starting duplicate aggregate DO RPCs.
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
    // Anonymous (or still resolving) goes straight to the public read-model
    // so we never pay the /user/* Access 302 + CORS round-trip. When auth
    // resolves to true the effect re-runs via `useAuthed`.
    const authOpt = useAuthed ? { isAuthed: true as const } : { isAuthed: false as const };
    const run = async () => {
      const key = `${owner}/${repo}/${ref}/${path}/${reloadKey}`;
      const st = overviewStateRef.current;
      // Same-key request already settled (public and authed overviews are
      // byte-identical, even for private repos served with a session): skip.
      // RepoView still upgrades meta for viewerRole.
      if (st.key === key) return;
      try {
        // Single aggregate read (one DO RPC): branches + tags + fast tree
        // + commits + README. Replaces the sequential branches/tags/tree/
        // commits/blob waterfall that serialized on the DO input gate.
        // A same-key request still in flight is awaited instead of
        // starting a second aggregate RPC.
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
          const promise = loadOverview(owner, repo, ref || undefined, path || undefined, { ...authOpt, depth: 10 });
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
        // Prefer a branch that exists: a dangling HEAD (fresh repo defaulting
        // to `main`, mirror of a `master` upstream) must not become the
        // selection, or the tree resolves to nothing.
        const fallbackBranch =
          overview.currentBranch && overview.branches.includes(overview.currentBranch)
            ? overview.currentBranch
            : (overview.branches[0] ?? null);
        setDefaultBranch(fallbackBranch);
        setTags(overview.tags);
        const tagRefs = new Set(overview.tags.map((tg) => tg.ref));
        const resolvedRef = resolveSelectedRef(ref, overview.branches, fallbackBranch, tagRefs);
        if (ref !== '' && resolvedRef !== ref) {
          // Unknown `?ref=` (e.g. a deleted branch in a pasted link) folds
          // back to the default branch, and the URL follows.
          navigateBrowser({ ref: resolvedRef === 'HEAD' ? '' : resolvedRef });
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
        // Gated enrichment (rows_read): skip when hidden or >30 entries, debounce 350ms.
        const shouldEnrich = overview.tree.length <= 30 && (typeof document === 'undefined' || !document.hidden);
        const enrichKey = `${key}/${treeRef ?? ''}/${dir ?? ''}`;
        if (shouldEnrich && st.enrichedKey !== enrichKey) {
          await new Promise((resolve) => setTimeout(resolve, 350));
          if (cancelled || (typeof document !== 'undefined' && document.hidden)) return;
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
        if (!cancelled) showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadFiles', 'Failed To Load Repository Files.'));
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, ref, path, showNotice, reloadKey, useAuthed]);

  const readmeEntry = findReadmeEntry(entries, path);

  const visibleReadme = readmeEntry && readme && readme.path === readmeEntry.path ? readme.text : null;

  const editing = editingPath !== null && editingPath === blobPath;
  const creating = createDir !== null && createDir === path;

  const afterChange = () => {
    setEditingPath(null);
    setCreateDir(null);
    navigateBrowser({ blob: null });
    setBlobText(null);
    setBlobBinary(false);
    setReadme(null);
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const openBlob = (entryPath: string) => {
    const fullPath = path ? `${path}/${entryPath}` : entryPath;
    // Navigate only; the loader effect below performs the single fetch for
    // clicks, Back/Forward, and pasted links alike.
    setBlobBinary(false);
    setBlobText(null);
    setEditingPath(null);
    navigateBrowser({ blob: fullPath });
  };

  // Sole blob loader: `blobPath` derives from the URL, so clicks,
  // Back/Forward, and pasted links all converge here with no state syncing.
  // Written as an effect-local `run()` like every other data loader in the
  // codebase; all updates happen after the await.
  useEffect(() => {
    if (!blobPath) return;
    const authOpt = useAuthed ? { isAuthed: true as const } : { isAuthed: false as const };
    const target = blobPath;
    let cancelled = false;
    const run = async () => {
      try {
        const blob = await loadBlob(owner, repo, target, ref || selectedRef || undefined, authOpt);
        if (cancelled) return;
        if (!blob) {
          showNotice('error', t('errors.fileNotFound', 'File Not Found.'));
          return;
        }
        setLoadedBlob(target);
        setBlobBinary(blob.isBinary);
        setBlobText(blob.isBinary ? null : decodeBlobContent(blob));
      } catch (error) {
        if (cancelled) return;
        showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToLoadFile', 'Failed To Load File.'));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blobPath]);

  const crumbs = path ? path.split('/') : [];
  const latestCommit = commits[0];

  return (
    <div className="space-y-4">
      <CodeTabToolbar
        owner={owner}
        repo={repo}
        branches={branches}
        defaultBranch={defaultBranch}
        selectedRef={selectedRef}
        placeholderLabel={placeholderLabel}
        refParam={ref}
        path={path}
        crumbs={crumbs}
        tags={tags}
        loading={loading}
        editable={editable}
        canWrite={canWrite}
        forksCount={repoMeta.forksCount ?? 0}
        forkOwner={forkOwner}
        authorized={authorized}
        social={social}
        showNotice={showNotice}
        navigateBrowser={navigateBrowser}
        setLoading={setLoading}
        setBlobText={setBlobText}
        setBlobBinary={setBlobBinary}
        setReadme={setReadme}
        setReloadKey={setReloadKey}
        setCreateDir={setCreateDir}
        onRefresh={refresh}
      />

      <div className="grid gap-6 lg:grid-cols-4 items-start">
        <div className="lg:col-span-3 space-y-4 min-w-0">
          {blobPath ? (
            <BlobView
              owner={owner}
              repo={repo}
              branch={selectedRef}
              blobPath={blobPath}
              blobText={visibleBlobText}
              blobBinary={visibleBlobBinary}
              branchTip={branchTip}
              editing={editing}
              editableFile={editableFile}
              showNotice={showNotice}
              onSaved={afterChange}
              onEdit={() => setEditingPath(blobPath)}
              onCancelEdit={() => setEditingPath(null)}
              onBack={() => {
                navigateBrowser({ blob: null });
                setBlobText(null);
                setEditingPath(null);
              }}
            />
          ) : (
            <FileBrowser
              owner={owner}
              repo={repo}
              branch={selectedRef}
              directory={path}
              entries={entries}
              latestCommit={latestCommit}
              loading={loading}
              showNewFile={creating && editable}
              showEmptyCreate={canWrite && branches.length === 0}
              emptyCreateBranch={defaultBranch ?? 'main'}
              branchTip={branchTip}
              showNotice={showNotice}
              onSaved={afterChange}
              onOpenBlob={openBlob}
              onNavigate={(dir) => {
                setLoading(true);
                navigateBrowser({ path: dir });
              }}
            />
          )}

          {visibleReadme && !blobPath && <ReadmeCard text={visibleReadme} />}
        </div>

        <CodeTabSidebar
          owner={owner}
          repo={repo}
          repoMeta={repoMeta}
          branches={branches}
          tags={tags}
          commits={commits}
          defaultBranch={defaultBranch}
          showNotice={showNotice}
          onSelectTag={(tagRef) => {
            setLoading(true);
            navigateBrowser({ ref: tagRef, path: '', blob: null });
            setBlobText(null);
            setBlobBinary(false);
            setReadme(null);
          }}
        />
      </div>
    </div>
  );
}
