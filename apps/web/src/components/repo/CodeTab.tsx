import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GitBranch, Tag } from 'lucide-react';
import type { GitCommit, OverviewResponse, Repo, TagInfo, TreeEntry } from '../../types';
import { decodeBlobContent, loadBlob, loadOverview, loadTree } from '../../services/repoService';
import { formatTimestamp } from '../../lib/format';
import { formatDateLocale } from '../../lib/locale';
import { resolveSelectedRef, mergeEnrichedEntries } from './useCodeTabOverview';
import { Card } from '../ui/Card';
import { Select } from '../ui/Input';
import { Button } from '../ui/Button';
import { Badge, VisibilityBadge } from '../ui/Badge';
import { Markdown } from '../shared/Markdown';
import { RefreshButton } from '../shared/RefreshButton';
import { CloneButton } from './CloneButton';
import { ForkButton } from './ForkButton';
import { ForkSyncButton } from './ForkSyncButton';
import { BranchActions } from './BranchActions';
import { BlobView } from './BlobView';
import { FileBrowser } from './FileBrowser';
import { RecentCommitsCard } from './RecentCommitsCard';
import { TagPicker, TagsCard } from './TagsCard';

const README_NAMES = new Set(['README.md', 'README.markdown', 'README.mdown', 'README.txt', 'README']);
// Upper bound for in-browser editing; larger files stay git-only.
const MAX_EDIT_CHARS = 262_144;

export function CodeTab({
  owner,
  repo,
  repoMeta,
  canFork,
  canWrite,
  forkOwner,
  showNotice,
  authorized,
}: {
  owner: string;
  repo: string;
  repoMeta: Repo;
  canFork: boolean;
  canWrite: boolean;
  forkOwner: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
  authorized?: boolean | null;
}) {
  const { t } = useTranslation();
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [ref, setRef] = useState('');
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [blobPath, setBlobPath] = useState<string | null>(null);
  const [blobText, setBlobText] = useState<string | null>(null);
  const [blobBinary, setBlobBinary] = useState(false);
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
  const emptyBranchesLabel = loading ? 'Loading...' : 'No Branches';
  const placeholderLabel = branches.length === 0 ? emptyBranchesLabel : selectedRef;
  // Web writes target branches only — tag refs are immutable snapshots.
  const isTagRef = ref.startsWith('refs/tags/');
  const editable = canWrite && !isTagRef && selectedRef !== '';
  const branchTip = commits[0]?.oid;
  const editableFile = editable && !blobBinary && (blobText ?? '').length <= MAX_EDIT_CHARS;

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
        setDefaultBranch(overview.currentBranch ?? overview.branches[0] ?? null);
        setTags(overview.tags);
        const tagRefs = new Set(overview.tags.map((tg) => tg.ref));
        const resolvedRef = resolveSelectedRef(ref, overview.branches, overview.currentBranch ?? overview.branches[0] ?? null, tagRefs);
        if (ref !== '' && resolvedRef !== ref) {
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
        // Lazy enrichment: re-fetch with last-commit and merge by path+oid.
        // Fire-and-forget relative to loading state so slow histories never
        // block the file list or README. Claimed per key so the auth-upgrade
        // run shares (or skips) instead of doubling the call.
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
  }, [owner, repo, ref, path, showNotice, reloadKey, useAuthed]);

  const readmeEntry = path === '' ? entries.find((e) => e.type === 'blob' && README_NAMES.has(e.path)) : undefined;

  const visibleReadme = readmeEntry && readme && readme.path === readmeEntry.path ? readme.text : null;

  const editing = editingPath !== null && editingPath === blobPath;
  const creating = createDir !== null && createDir === path;

  const afterChange = () => {
    setEditingPath(null);
    setCreateDir(null);
    setBlobPath(null);
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

  const openBlob = async (entryPath: string) => {
    const fullPath = path ? `${path}/${entryPath}` : entryPath;
    try {
      const authOpt = useAuthed ? { isAuthed: true as const } : { isAuthed: false as const };
      const blob = await loadBlob(owner, repo, fullPath, selectedRef || undefined, authOpt);
      if (!blob) {
        showNotice('error', 'File Not Found.');
        return;
      }
      setBlobPath(fullPath);
      setBlobBinary(blob.isBinary);
      setBlobText(blob.isBinary ? null : decodeBlobContent(blob));
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Failed To Load File.');
    }
  };

  const crumbs = path ? path.split('/') : [];
  const latestCommit = commits[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={selectedRef}
          onChange={(e) => {
            setLoading(true);
            setRef(e.target.value);
            setBlobPath(null);
            setBlobText(null);
            setBlobBinary(false);
            setReadme(null);
          }}
          aria-label="Branch"
          disabled={branches.length === 0}
        >
          {!branches.includes(selectedRef) && <option value="">{placeholderLabel}</option>}
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </Select>
        <TagPicker
          tags={tags}
          value={ref.startsWith('refs/tags/') ? ref : ''}
          onChange={(tagRef) => {
            setLoading(true);
            setRef(tagRef);
            setPath('');
            setBlobPath(null);
            setBlobText(null);
            setBlobBinary(false);
            setReadme(null);
          }}
        />
        {canWrite && (
          <BranchActions
            owner={owner}
            repo={repo}
            branches={branches}
            defaultBranch={defaultBranch}
            selectedRef={selectedRef}
            showNotice={showNotice}
            onChanged={(nextRef) => {
              setLoading(true);
              setRef(nextRef);
              setPath('');
              setBlobPath(null);
              setBlobText(null);
              setBlobBinary(false);
              setReadme(null);
              setReloadKey((k) => k + 1);
            }}
          />
        )}
        {editable && (
          <Button
            size="sm"
            onClick={() => {
              setCreateDir((d) => (d === path ? null : path));
              setBlobPath(null);
              setBlobText(null);
              setBlobBinary(false);
              setEditingPath(null);
            }}
          >
            {t('files.newFile', 'New File')}
          </Button>
        )}
        {path && (
          <nav className="text-sm text-[var(--color-text-secondary)]">
            <button type="button" className="text-[var(--color-accent)] hover:underline" onClick={() => setPath('')}>
              {repo}
            </button>
            {crumbs.map((c, i) => (
              <span key={i}>
                {' / '}
                <button
                  type="button"
                  className="text-[var(--color-accent)] hover:underline"
                  onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}
                >
                  {c}
                </button>
              </span>
            ))}
          </nav>
        )}
        <div className="ml-auto flex items-center gap-2">
          <RefreshButton onRefresh={refresh} loading={loading} />
          {canFork && <ForkButton owner={owner} repo={repo} defaultOwner={forkOwner} showNotice={showNotice} />}
          <CloneButton owner={owner} repo={repo} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-4 items-start">
        <div className="lg:col-span-3 space-y-4 min-w-0">
          {blobPath ? (
            <BlobView
              owner={owner}
              repo={repo}
              branch={selectedRef}
              blobPath={blobPath}
              blobText={blobText}
              blobBinary={blobBinary}
              branchTip={branchTip}
              editing={editing}
              editableFile={editableFile}
              showNotice={showNotice}
              onSaved={afterChange}
              onEdit={() => setEditingPath(blobPath)}
              onCancelEdit={() => setEditingPath(null)}
              onBack={() => {
                setBlobPath(null);
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
                setPath(dir);
              }}
            />
          )}

          {visibleReadme && !blobPath && (
            <Card>
              <h2 className="text-base font-semibold text-[var(--color-text-primary)] mb-3">README</h2>
              <Markdown content={visibleReadme} />
            </Card>
          )}
        </div>

        <aside className="lg:col-span-1 space-y-4 min-w-0">
          <Card>
            <h2 className="text-base font-semibold text-[var(--color-text-primary)] mb-3">About</h2>
            {repoMeta.description ? (
              <p className="text-sm text-[var(--color-text-secondary)]">{repoMeta.description}</p>
            ) : (
              <p className="text-sm text-[var(--color-text-muted)] italic">No description provided.</p>
            )}
            <div className="mt-3">
              <VisibilityBadge isPrivate={repoMeta.isPrivate} />
            </div>
            {repoMeta.forkedFrom && (
              <>
                <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                  {t('forks.forkedFrom', 'Forked From')}{' '}
                  <Link className="text-[var(--color-accent)] hover:underline font-mono" to={`/${repoMeta.forkedFrom}`}>
                    {repoMeta.forkedFrom}
                  </Link>
                </p>
                <div className="mt-2">
                  <ForkSyncButton owner={owner} repo={repo} upstreamFull={repoMeta.forkedFrom} branch={defaultBranch ?? 'main'} showNotice={showNotice} />
                </div>
              </>
            )}
            <dl className="mt-4 space-y-2.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
                  <GitBranch className="h-3.5 w-3.5" />
                  Branches
                </dt>
                <dd>
                  <Badge variant="neutral">{branches.length}</Badge>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[var(--color-text-muted)] inline-flex items-center gap-1.5">
                  <Tag className="h-3.5 w-3.5" />
                  {t('repos.tags', 'Tags')}
                </dt>
                <dd>
                  <Badge variant="neutral">{tags.length}</Badge>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[var(--color-text-muted)]">Default</dt>
                <dd className="font-mono text-xs text-[var(--color-text-primary)] truncate">{defaultBranch ?? '—'}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[var(--color-text-muted)]">Created</dt>
                <dd className="text-xs text-[var(--color-text-secondary)]">{formatDateLocale(new Date(repoMeta.createdAt * 1000))}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[var(--color-text-muted)]">Updated</dt>
                <dd className="text-xs text-[var(--color-text-secondary)]">{formatTimestamp(repoMeta.updatedAt)}</dd>
              </div>
            </dl>
          </Card>

          <RecentCommitsCard commits={commits} owner={owner} repo={repo} />

          <TagsCard
            tags={tags}
            onSelect={(tagRef) => {
              setLoading(true);
              setRef(tagRef);
              setPath('');
              setBlobPath(null);
              setBlobText(null);
              setBlobBinary(false);
              setReadme(null);
            }}
          />
        </aside>
      </div>
    </div>
  );
}
