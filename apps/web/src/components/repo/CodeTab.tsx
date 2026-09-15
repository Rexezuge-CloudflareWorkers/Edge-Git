import { useEffect, useState } from 'react';
import { File, Folder } from 'lucide-react';
import type { GitCommit, TreeEntry } from '../../types';
import { decodeBlobContent, loadBlob, loadBranches, loadCommits, loadTree } from '../../services/repoService';
import { firstLine, formatCommitDate, formatTimestamp } from '../../lib/format';
import { Card } from '../ui/Card';
import { Select } from '../ui/Input';
import { Markdown } from '../shared/Markdown';
import { RefreshButton } from '../shared/RefreshButton';
import { ReadOnlyField } from '../shared/ReadOnlyField';

const README_NAMES = new Set(['README.md', 'README.markdown', 'README.mdown', 'README.txt', 'README']);

export function CodeTab({
  owner,
  repo,
  showNotice,
}: {
  owner: string;
  repo: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const [branches, setBranches] = useState<string[]>([]);
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

  useEffect(() => {
    const run = async () => {
      try {
        const b = await loadBranches(owner, repo);
        setBranches(b.branches);
        const effectiveRef = ref || b.currentBranch || b.branches[0] || 'HEAD';
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
    loadBlob(owner, repo, readmeEntry.path, ref || undefined)
      .then((blob) => {
        if (cancelled || !blob || blob.isBinary) return;
        const text = decodeBlobContent(blob);
        if (text !== null) setReadme({ path: readmeEntry.path, text });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [owner, repo, ref, readmeEntry]);

  const visibleReadme = readmeEntry && readme && readme.path === readmeEntry.path ? readme.text : null;

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const openBlob = async (entryPath: string) => {
    const fullPath = path ? `${path}/${entryPath}` : entryPath;
    try {
      const blob = await loadBlob(owner, repo, fullPath, ref || undefined);
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={ref}
          onChange={(e) => {
            setLoading(true);
            setRef(e.target.value);
          }}
          aria-label="Branch"
        >
          {!branches.includes(ref) && <option value="">{ref || 'Default branch'}</option>}
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </Select>
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
        <div className="ml-auto">
          <RefreshButton onRefresh={refresh} loading={loading} />
        </div>
      </div>

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

      <Card>
        <h2 className="text-base font-semibold text-[var(--color-text-primary)] mb-3">Recent Commits</h2>
        {commits.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">No commits yet.</p>
        ) : (
          <ul className="space-y-3">
            {commits.map((c) => (
              <li key={c.oid} className="text-sm">
                <p className="text-[var(--color-text-primary)]">{firstLine(c.commit.message)}</p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {c.commit.author.name} committed {formatCommitDate(c.commit.author.timestamp, c.commit.author.timezoneOffset)} ·{' '}
                  <code className="font-mono">{c.oid.slice(0, 7)}</code>
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="text-base font-semibold text-[var(--color-text-primary)] mb-3">Clone</h2>
        <div className="space-y-3">
          <ReadOnlyField label="HTTPS" value={`${globalThis.location?.origin ?? ''}/${owner}/${repo}`} showCopy />
          <p className="text-sm text-[var(--color-text-secondary)]">
            Use a personal access token as the password for private fetch and push.
          </p>
        </div>
      </Card>
    </div>
  );
}
