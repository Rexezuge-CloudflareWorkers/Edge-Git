import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { File, Folder, GitBranch, Tag } from 'lucide-react';
import type { GitCommit, Repo, TagInfo, TreeEntry } from '../../types';
import { decodeBlobContent, loadBlob, loadBranches, loadCommits, loadTags, loadTree } from '../../services/repoService';
import { firstLine, formatCommitDate, formatTimestamp } from '../../lib/format';
import { formatDateLocale } from '../../lib/locale';
import { Card } from '../ui/Card';
import { Select } from '../ui/Input';
import { Badge, VisibilityBadge } from '../ui/Badge';
import { Markdown } from '../shared/Markdown';
import { RefreshButton } from '../shared/RefreshButton';
import { CloneButton } from './CloneButton';
import { ForkButton } from './ForkButton';
import { RecentCommitsCard } from './RecentCommitsCard';
import { TagPicker, TagsCard } from './TagsCard';

const README_NAMES = new Set(['README.md', 'README.markdown', 'README.mdown', 'README.txt', 'README']);

export function CodeTab({
  owner,
  repo,
  repoMeta,
  canFork,
  forkOwner,
  showNotice,
}: {
  owner: string;
  repo: string;
  repoMeta: Repo;
  canFork: boolean;
  forkOwner: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
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

  const [reloadKey, setReloadKey] = useState(0);

  // `ref` is the explicit user selection (`''` = follow the default branch).
  // `selectedRef` is what is displayed and used for fetching, so the dropdown
  // shows the actual branch name (e.g. `main`) instead of a generic placeholder.
  const selectedRef = ref || defaultBranch || branches[0] || '';
  const emptyBranchesLabel = loading ? 'Loading...' : 'No Branches';
  const placeholderLabel = branches.length === 0 ? emptyBranchesLabel : selectedRef;

  useEffect(() => {
    const run = async () => {
      try {
        const b = await loadBranches(owner, repo);
        setBranches(b.branches);
        setDefaultBranch(b.currentBranch ?? b.branches[0] ?? null);
        let loadedTags: TagInfo[] = [];
        try {
          loadedTags = await loadTags(owner, repo);
        } catch {
          loadedTags = [];
        }
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
        const [tree, log] = await Promise.all([
          loadTree(owner, repo, effectiveRef === 'HEAD' ? undefined : effectiveRef, path || undefined),
          loadCommits(owner, repo, effectiveRef === 'HEAD' ? undefined : effectiveRef, 10),
        ]);
        setEntries(tree);
        setCommits(log);
      } catch (error) {
        showNotice('error', error instanceof Error ? error.message : 'Failed To Load Repository Files.');
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [owner, repo, ref, path, showNotice, reloadKey]);

  const readmeEntry = path === '' ? entries.find((e) => e.type === 'blob' && README_NAMES.has(e.path)) : undefined;

  // Auto-load README at the repo root
  useEffect(() => {
    if (!readmeEntry) return;
    let cancelled = false;
    loadBlob(owner, repo, readmeEntry.path, selectedRef || undefined)
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
  }, [owner, repo, selectedRef, readmeEntry?.path]);

  const visibleReadme = readmeEntry && readme && readme.path === readmeEntry.path ? readme.text : null;

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const openBlob = async (entryPath: string) => {
    const fullPath = path ? `${path}/${entryPath}` : entryPath;
    try {
      const blob = await loadBlob(owner, repo, fullPath, selectedRef || undefined);
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
            <Card>
              <div className="flex items-center justify-between mb-3">
                <span className="font-mono text-sm text-[var(--color-text-primary)]">{blobPath}</span>
                <button
                  type="button"
                  className="text-sm text-[var(--color-accent)] hover:underline"
                  onClick={() => {
                    setBlobPath(null);
                    setBlobText(null);
                  }}
                >
                  Back To Files
                </button>
              </div>
              {blobBinary ? (
                <p className="text-sm text-[var(--color-text-muted)]">Binary file — not previewed.</p>
              ) : (
                <pre className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-base)] p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
                  {blobText ?? 'Empty file.'}
                </pre>
              )}
            </Card>
          ) : (
            <Card className="p-0 overflow-hidden">
              {latestCommit && (
                <div className="flex items-center gap-3 px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] text-sm min-w-0">
                  <span className="h-6 w-6 rounded-full bg-[var(--color-surface-4)] text-[var(--color-text-secondary)] inline-flex items-center justify-center text-xs font-medium shrink-0">
                    {latestCommit.commit.author.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="text-[var(--color-text-primary)] truncate flex-1">{firstLine(latestCommit.commit.message)}</span>
                  <code className="font-mono text-xs text-[var(--color-text-muted)] shrink-0 hidden sm:inline">
                    {latestCommit.oid.slice(0, 7)}
                  </code>
                  <span className="text-xs text-[var(--color-text-muted)] shrink-0 hidden md:inline">
                    {formatCommitDate(latestCommit.commit.author.timestamp, latestCommit.commit.author.timezoneOffset)}
                  </span>
                </div>
              )}
              {!loading && entries.length === 0 ? (
                <p className="text-sm text-[var(--color-text-muted)] p-5">Empty repository — push a branch to get started.</p>
              ) : (
                <ul className="divide-y divide-[var(--color-border)]">
                  {path && (
                    <li>
                      <button
                        type="button"
                        className="w-full text-left px-5 py-2.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
                        onClick={() => setPath(crumbs.slice(0, -1).join('/'))}
                      >
                        ..
                      </button>
                    </li>
                  )}
                  {entries.map((e) => (
                    <li key={e.oid + e.path}>
                      <button
                        type="button"
                        className="w-full flex items-center gap-3 px-5 py-2.5 text-sm hover:bg-[var(--color-surface-2)] text-left"
                        onClick={() => {
                          if (e.type === 'tree') {
                            setLoading(true);
                            setPath(path ? `${path}/${e.path}` : e.path);
                          } else {
                            void openBlob(e.path);
                          }
                        }}
                      >
                        {e.type === 'tree' ? (
                          <Folder className="h-4 w-4 text-[var(--color-info-text)] shrink-0" />
                        ) : (
                          <File className="h-4 w-4 text-[var(--color-text-muted)] shrink-0" />
                        )}
                        <span className="text-[var(--color-text-primary)] truncate flex-1">{e.path}</span>
                        <span className="text-xs text-[var(--color-text-muted)] truncate max-w-64 hidden md:inline">
                          {e.lastCommit ? firstLine(e.lastCommit.commit.message) : ''}
                        </span>
                        <span className="text-xs text-[var(--color-text-muted)] shrink-0">
                          {e.lastCommit ? formatTimestamp(e.lastCommit.commit.author.timestamp) : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
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
