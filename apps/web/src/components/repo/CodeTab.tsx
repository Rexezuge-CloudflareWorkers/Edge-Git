import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GitBranch, Tag } from 'lucide-react';
import type { GitCommit, Repo, TagInfo, TreeEntry } from '../../types';
import { decodeBlobContent, loadBlob, loadBranches, loadCommits, loadTags, loadTree } from '../../services/repoService';
import { formatTimestamp } from '../../lib/format';
import { formatDateLocale } from '../../lib/locale';
import { Card } from '../ui/Card';
import { Select } from '../ui/Input';
import { Button } from '../ui/Button';
import { Badge, VisibilityBadge } from '../ui/Badge';
import { Markdown } from '../shared/Markdown';
import { RefreshButton } from '../shared/RefreshButton';
import { CloneButton } from './CloneButton';
import { ForkButton } from './ForkButton';
import { BranchActions } from './BranchActions';
import { BlobView } from './BlobView';
import { FileBrowser } from './FileBrowser';
import { RecentCommitsCard } from './RecentCommitsCard';
import { TagPicker, TagsCard } from './TagsCard';

const README_NAMES = new Set(['README.md', 'README.markdown', 'README.mdown', 'README.txt', 'README']);
// Upper bound for in-browser editing; larger files stay git-only.
const MAX_EDIT_CHARS = 262_144;

// Merge lazily enriched last-commit info into the fast tree by path+oid.
// Extracted to module scope so the CodeTab effect stays within the
// max-nesting lint budget.
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

  useEffect(() => {
    let cancelled = false;
    // `authorized !== true` (anonymous or still resolving) goes straight to
    // the public read-model so we never pay the /user/* Access 302 + CORS
    // round-trip. When auth resolves to true the effect re-runs via `authorized`.
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    const run = async () => {
      try {
        const [b, loadedTags] = await Promise.all([
          loadBranches(owner, repo, authOpt),
          loadTags(owner, repo, authOpt).catch(() => [] as TagInfo[]),
        ]);
        if (cancelled) return;
        setBranches(b.branches);
        setDefaultBranch(b.currentBranch ?? b.branches[0] ?? null);
        setTags(loadedTags);
        const tagRefs = new Set(loadedTags.map((tg) => tg.ref));
        // If the current selection no longer exists (e.g. after switching
        // repos while `ref` still holds the previous repo's branch), fall
        // back to the new repo's default branch. Known tag refs are kept.
        const isKnownRef = (ref.startsWith('refs/tags/') && tagRefs.has(ref)) || (ref !== '' && b.branches.includes(ref));
        const resolvedRef = isKnownRef ? ref : (b.currentBranch ?? b.branches[0] ?? 'HEAD');
        if (ref !== '' && resolvedRef !== ref) {
          setRef(resolvedRef === 'HEAD' ? '' : resolvedRef);
        }
        const effectiveRef = resolvedRef;
        const treeRef = effectiveRef === 'HEAD' ? undefined : effectiveRef;
        const dir = path || undefined;
        // Fast path: tree without per-file last-commit (avoids the DO N+1
        // getLog-per-entry) alongside the commit list, so the file list
        // paints early. Enrichment follows lazily below.
        const [tree, log] = await Promise.all([
          loadTree(owner, repo, treeRef, dir, { ...authOpt, withLastCommit: false }),
          loadCommits(owner, repo, treeRef, 10, authOpt),
        ]);
        if (cancelled) return;
        setEntries(tree);
        setCommits(log);
        setLoading(false);
        // Lazy enrichment: re-fetch with last-commit and merge by path+oid.
        // Fire-and-forget relative to loading state so slow histories never
        // block the file list or README.
        try {
          const enriched = await loadTree(owner, repo, treeRef, dir, { ...authOpt, withLastCommit: true });
          if (cancelled) return;
          setEntries((prev) => mergeEnrichedEntries(prev, enriched));
        } catch {
          // Enrichment is best-effort; fast tree already rendered.
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
  }, [owner, repo, ref, path, showNotice, reloadKey, authorized]);

  const readmeEntry = path === '' ? entries.find((e) => e.type === 'blob' && README_NAMES.has(e.path)) : undefined;

  // Auto-load README at the repo root
  useEffect(() => {
    if (!readmeEntry) return;
    let cancelled = false;
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    loadBlob(owner, repo, readmeEntry.path, selectedRef || undefined, authOpt)
      .then((blob) => {
        if (cancelled || !blob || blob.isBinary) return;
        const text = decodeBlobContent(blob);
        if (text !== null) setReadme({ path: readmeEntry.path, text });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, repo, selectedRef, readmeEntry?.path, authorized]);

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
      const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
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
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                {t('forks.forkedFrom', 'Forked From')}{' '}
                <Link className="text-[var(--color-accent)] hover:underline font-mono" to={`/${repoMeta.forkedFrom}`}>
                  {repoMeta.forkedFrom}
                </Link>
              </p>
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
